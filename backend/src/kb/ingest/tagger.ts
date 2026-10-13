/**
 * Attaches chunks to the domain model deterministically (v4 §N1.4). No LLM assigns a tag:
 * cosine similarity between each chunk embedding and each subtopic embedding, thresholded.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { concepts, sourceChunks, subtopics, topics } from "../../db/schema.js";
import { embedText } from "../../lib/embeddingClient.js";

/** Tuned on hand-labelled chunks with `npm run kb:tune-tau`; override with KB_TAG_TAU. */
export const TAG_TAU = Number(process.env.KB_TAG_TAU ?? 0.6);
export const TAG_SECOND_MARGIN = 0.03;

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export type Candidate = { id: string; vec: number[] };
export type TagResult = { subtopicIds: string[]; conceptIds: string[]; similarity: number | null };

/** Top subtopic if sim ≥ τ; second too if within the margin of the first. Pure. */
export function pickTags(
  chunkVec: number[],
  subtopicVecs: Candidate[],
  conceptsBySubtopic: Map<string, Candidate[]>,
  tau = TAG_TAU,
): TagResult {
  const ranked = subtopicVecs.map((s) => ({ id: s.id, sim: cosine(chunkVec, s.vec) })).sort((a, b) => b.sim - a.sim);
  const top = ranked[0];
  if (!top || top.sim < tau) return { subtopicIds: [], conceptIds: [], similarity: top ? round3(top.sim) : null };
  const chosen = [top];
  if (ranked[1] && ranked[1].sim >= tau && top.sim - ranked[1].sim <= TAG_SECOND_MARGIN) chosen.push(ranked[1]);

  const conceptIds: string[] = [];
  for (const s of chosen) {
    const cs = (conceptsBySubtopic.get(s.id) ?? [])
      .map((c) => ({ id: c.id, sim: cosine(chunkVec, c.vec) }))
      .sort((a, b) => b.sim - a.sim);
    if (cs[0] && cs[0].sim >= tau) {
      conceptIds.push(cs[0].id);
      if (cs[1] && cs[1].sim >= tau && cs[0].sim - cs[1].sim <= TAG_SECOND_MARGIN) conceptIds.push(cs[1].id);
    }
  }
  return { subtopicIds: chosen.map((c) => c.id), conceptIds, similarity: round3(top.sim) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function parseVector(text: string): number[] {
  return text.replace(/^\[|\]$/g, "").split(",").map(Number);
}

export type SubtopicIndex = { subtopicVecs: Candidate[]; conceptVecs: Map<string, Candidate[]>; names: Map<string, string> };

/** Embeds every subtopic of a subject once (name + description + concept names), and each concept. */
export async function buildSubtopicIndex(subjectId: string, concurrency = 4): Promise<SubtopicIndex> {
  const subs = await db
    .select({ id: subtopics.id, name: subtopics.name, description: subtopics.description })
    .from(subtopics)
    .innerJoin(topics, eq(topics.id, subtopics.topicId))
    .where(eq(topics.subjectId, subjectId));
  const cons = subs.length ? await db.select().from(concepts).where(inArray(concepts.subtopicId, subs.map((s) => s.id))) : [];
  const consBySub = new Map<string, typeof cons>();
  for (const c of cons) consBySub.set(c.subtopicId, [...(consBySub.get(c.subtopicId) ?? []), c]);

  const jobs: Array<{ key: string; text: string }> = [];
  for (const s of subs) {
    jobs.push({ key: `s:${s.id}`, text: [s.name, s.description, ...(consBySub.get(s.id) ?? []).map((c) => c.name)].filter(Boolean).join(". ") });
    for (const c of consBySub.get(s.id) ?? []) jobs.push({ key: `c:${c.id}`, text: `${s.name}: ${c.name}` });
  }
  const vecs = new Map<string, number[]>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      vecs.set(jobs[i].key, await embedText(jobs[i].text));
    }
  }));
  return {
    subtopicVecs: subs.map((s) => ({ id: s.id, vec: vecs.get(`s:${s.id}`)! })),
    conceptVecs: new Map(subs.map((s) => [s.id, (consBySub.get(s.id) ?? []).map((c) => ({ id: c.id, vec: vecs.get(`c:${c.id}`)! }))])),
    names: new Map(subs.map((s) => [s.id, s.name])),
  };
}

/** Tags every embedded chunk of a source. Untagged chunks keep empty arrays (searchable, never used for questions). */
export async function tagSource(sourceId: string, subjectId: string, tau = TAG_TAU, index?: SubtopicIndex): Promise<{ tagged: number; untagged: number }> {
  const idx = index ?? (await buildSubtopicIndex(subjectId));
  const rows = await db.execute<{ id: string; emb: string }>(
    sql`select id, embedding::text as emb from source_chunks where source_id = ${sourceId} and embedding is not null`,
  );
  let tagged = 0, untagged = 0;
  for (const r of rows.rows) {
    const res = pickTags(parseVector(r.emb), idx.subtopicVecs, idx.conceptVecs, tau);
    await db.update(sourceChunks).set({
      subtopicIds: res.subtopicIds, conceptIds: res.conceptIds,
      tagSimilarity: res.similarity === null ? null : res.similarity.toFixed(3),
    }).where(eq(sourceChunks.id, r.id));
    if (res.subtopicIds.length) tagged++; else untagged++;
  }
  return { tagged, untagged };
}
