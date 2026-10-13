/**
 * Questions grounded in the knowledge base (v4 §N6.1). The LLM writes MCQs from ONE chunk; code accepts
 * a question only if its evidence_quote is a normalised substring of that chunk (the same gate as K3).
 * Accepted questions are stored `origin = 'kb_generated'`, `reviewed = false`; a human must read every
 * answer key before the demo student can ever receive one (`npm run mark:reviewed -- --kb dsa`).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { kbComplete } from "../../agent/llm/kb.js";
import { db } from "../../db/client.js";
import { concepts, questions, sourceChunks, sources, subtopics } from "../../db/schema.js";
import { normalizeText, wordCount } from "../ingest/types.js";

export const RawQuestionSchema = z.object({
  stem: z.string(),
  options: z.array(z.string()),
  correct_index: z.number().int(),
  explanation: z.string(),
  concept_id: z.string().nullable().optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  evidence_quote: z.string(),
});
export const BatchSchema = z.object({ questions: z.array(RawQuestionSchema) });
export type RawQuestion = z.infer<typeof RawQuestionSchema>;

export type Rejection = "bad_shape" | "quote_not_in_chunk" | "quote_length" | "banned_phrase" | "duplicate_options" | "unknown_concept";
export type Accepted = { stem: string; options: string[]; correctIndex: number; explanation: string; conceptId: string | null; difficulty: number; evidenceQuote: string };

const BANNED = /\ball of the above\b|\bnone of the above\b/i;

/** Pure acceptance check. Returns the cleaned question or the reason it was discarded. */
export function acceptQuestion(raw: RawQuestion, chunk: { text: string; visualDescription: string | null }, conceptIds: string[]): { ok: true; q: Accepted } | { ok: false; reason: Rejection } {
  if (raw.stem.trim().length < 10 || raw.options.length !== 4 || raw.correct_index < 0 || raw.correct_index > 3 || raw.explanation.trim().length < 10 || raw.options.some((o) => !o.trim())) return { ok: false, reason: "bad_shape" };
  if (BANNED.test(raw.stem) || raw.options.some((o) => BANNED.test(o))) return { ok: false, reason: "banned_phrase" };
  if (new Set(raw.options.map((o) => normalizeText(o))).size !== 4) return { ok: false, reason: "duplicate_options" };
  const words = wordCount(raw.evidence_quote);
  if (words < 6 || words > 30) return { ok: false, reason: "quote_length" };
  const haystack = normalizeText(`${chunk.text} ${chunk.visualDescription ?? ""}`);
  if (!haystack.includes(normalizeText(raw.evidence_quote))) return { ok: false, reason: "quote_not_in_chunk" };
  const conceptId = raw.concept_id ?? null;
  if (conceptId !== null && !conceptIds.includes(conceptId)) return { ok: false, reason: "unknown_concept" };
  return { ok: true, q: { stem: raw.stem.trim(), options: raw.options.map((o) => o.trim()), correctIndex: raw.correct_index, explanation: raw.explanation.trim(), conceptId, difficulty: raw.difficulty ?? 3, evidenceQuote: raw.evidence_quote.trim() } };
}

export type GenerateReport = { chunks: number; generated: number; accepted: number; rejected: Record<string, number>; stored: number };

export async function generateFromKb(subjectId: string, opts: { chunksPerGroup?: number; perChunk?: number; log?: (m: string) => void; generate?: typeof llmGenerate } = {}): Promise<GenerateReport> {
  const log = opts.log ?? (() => {});
  const generate = opts.generate ?? llmGenerate;
  const perGroup = opts.chunksPerGroup ?? 6;
  const perChunk = opts.perChunk ?? 2;
  const report: GenerateReport = { chunks: 0, generated: 0, accepted: 0, rejected: {}, stored: 0 };

  const rows = await db
    .select({ chunk: sourceChunks, sourceId: sources.id })
    .from(sourceChunks).innerJoin(sources, eq(sources.id, sourceChunks.sourceId))
    .where(and(eq(sources.subjectId, subjectId), eq(sourceChunks.lowInformation, false), sql`cardinality(${sourceChunks.subtopicIds}) > 0`));

  // group = subtopic × source; best-tagged chunks first, skip near-empty ones
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (wordCount(`${r.chunk.text} ${r.chunk.visualDescription ?? ""}`) < 25) continue;
    const key = `${r.chunk.subtopicIds[0]}|${r.sourceId}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const subtopicIds = [...new Set([...groups.keys()].map((k) => k.split("|")[0]))];
  const subRows = subtopicIds.length ? await db.select().from(subtopics).where(inArray(subtopics.id, subtopicIds)) : [];
  const subInfo = new Map(subRows.map((s) => [s.id, s]));
  const conceptRows = subtopicIds.length ? await db.select().from(concepts).where(inArray(concepts.subtopicId, subtopicIds)) : [];

  for (const [key, group] of groups) {
    const [subtopicId] = key.split("|");
    const sub = subInfo.get(subtopicId);
    if (!sub) continue;
    const subConcepts = conceptRows.filter((c) => c.subtopicId === subtopicId);
    const picked = group.sort((a, b) => Number(b.chunk.tagSimilarity ?? 0) - Number(a.chunk.tagSimilarity ?? 0)).slice(0, perGroup);
    for (const { chunk } of picked) {
      report.chunks++;
      let batch: RawQuestion[] = [];
      try {
        batch = await generate({ subtopic_name: sub.name, concepts: subConcepts.map((c) => ({ id: c.id, name: c.name })), passage: { chunk_id: chunk.id, text: chunk.text, visual_description: chunk.visualDescription }, count: perChunk });
      } catch (e) {
        log(`  ${chunk.id}: generation failed (${(e as Error).message.slice(0, 80)})`);
        continue;
      }
      report.generated += batch.length;
      let n = 0;
      for (const raw of batch) {
        const res = acceptQuestion(raw, chunk, subConcepts.map((c) => c.id));
        if (!res.ok) { report.rejected[res.reason] = (report.rejected[res.reason] ?? 0) + 1; continue; }
        report.accepted++;
        const id = `kbq_${chunk.id.replace(/[^A-Za-z0-9]+/g, "_")}_${n++}`;
        const [topic] = await db.execute<{ topic_id: string }>(sql`select topic_id from subtopics where id = ${subtopicId}`).then((r) => r.rows);
        await db.insert(questions).values({
          id, subjectId, topicId: topic.topic_id, subtopicId, conceptId: res.q.conceptId, difficulty: res.q.difficulty,
          stem: res.q.stem, options: res.q.options, correctIndex: res.q.correctIndex, explanation: res.q.explanation,
          reviewed: false, origin: "kb_generated", sourceChunkId: chunk.id, evidenceQuote: res.q.evidenceQuote,
        }).onConflictDoNothing();
        report.stored++;
      }
    }
    log(`${key}: ${picked.length} chunk(s) done`);
  }
  return report;
}

async function llmGenerate(input: { subtopic_name: string; concepts: Array<{ id: string; name: string }>; passage: { chunk_id: string; text: string; visual_description: string | null }; count: number }): Promise<RawQuestion[]> {
  const { value } = await kbComplete({ agent: "kb_question_gen", user: input, schema: BatchSchema, maxTokens: 2500, offline: true });
  return value.questions;
}

export function formatReport(r: GenerateReport): string {
  const rej = Object.entries(r.rejected).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  return `chunks ${r.chunks} · generated ${r.generated} · accepted ${r.accepted} · stored ${r.stored} · discarded: ${rej}`;
}
