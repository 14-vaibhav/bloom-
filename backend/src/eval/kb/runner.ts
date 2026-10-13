/**
 * npm run eval:kb — measures the knowledge base end to end (v4 §N7.2). READ-ONLY: it never writes a row
 * (no students, no tutor turns). Writes docs/kb-eval-report.md and docs/kb-eval-results.json.
 *
 * Faithfulness is hand-graded: the run writes docs/kb-eval-grading.md listing each shown answer next to
 * the passages it cites; record verdicts in docs/kb-eval-grades.json as { "<question id>": true|false }
 * and re-run to fold them in.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db/client.js";
import { students } from "../../db/schema.js";
import { llmEnabled } from "../../agent/llm/kb.js";
import { searchCourseContent } from "../../kb/retrieval.js";
import { askTutor } from "../../tutor/tutor.js";
import { validateCitations } from "../../tutor/citationValidator.js";
import { aggregate, matchesGold, renderReport, type GoldQuestion, type PerQuestion } from "./metrics.js";
import { ASSET_ROOT } from "../../kb/ingest/run.js";
import { sources } from "../../db/schema.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const DOCS = path.join(ROOT, "docs");

async function main() {
  const gold = (JSON.parse(readFileSync(path.join(import.meta.dirname, "gold.json"), "utf8")).questions ?? []) as GoldQuestion[];
  if (gold.length === 0) {
    console.error("gold.json has no questions. Write the 20-question gold set from the ingested course material first (see the _comment in gold.json).");
    process.exitCode = 1;
    return;
  }
  const [student] = await db.select({ id: students.id }).from(students).where(eq(students.email, "demo@bloom.local"));
  if (!student) throw new Error("Demo student not found — run `npm run seed` first.");
  const srcRows = await db.select().from(sources);
  const sourceInfo = new Map(srcRows.map((s) => [s.id, { kind: s.kind, duration_sec: s.durationSec, unit_count: s.unitCount }]));

  const rows: PerQuestion[] = [];
  const grading: string[] = ["# Faithfulness grading sheet", "", "For each shown answer, read it against the cited passages and record true (says what the passages say) or false in `docs/kb-eval-grades.json`.", ""];
  for (const g of gold) {
    const search = await searchCourseContent({ query: g.question, k: 8 });
    const top5 = search.chunks.slice(0, 5);
    const hit = g.kind === "unanswerable" ? null : top5.some((c) => matchesGold(c, g));

    const turn = await askTutor({ studentId: student.id, question: g.question, deps: { record: false } });
    const declined = turn.outcome.startsWith("declined");
    const answer = turn.answer;
    const cited = answer ? [...new Set(answer.segments.flatMap((s) => s.chunk_ids))].map((id) => turn.chunks.find((c) => c.chunk_id === id)).filter((c) => !!c) : [];
    const independent = answer ? validateCitations({ answer, retrieved: turn.chunks, mode: turn.mode ?? "connect", sources: sourceInfo, assetExists: (p) => existsSync(path.join(ASSET_ROOT, p)) }) : null;
    const hardOk = (r: typeof independent) => !!r && r.checks.filter((c) => ["K1", "K2", "K3", "K4"].includes(c.id)).every((c) => c.passed);

    const row: PerQuestion = {
      id: g.id, kind: g.kind, question: g.question, outcome: turn.outcome, retrieval_mode: turn.retrieval_mode, hit_at_5: hit,
      first_pass_valid: g.kind === "unanswerable" ? null : turn.outcome === "answered" && turn.repair_rounds === 0,
      shown_valid: declined ? null : hardOk(independent),
      cross_source: declined ? null : new Set(cited.map((c) => c!.kind)).size >= 2,
      cites_expected: g.kind === "unanswerable" ? null : cited.some((c) => matchesGold(c!, g)),
      declined, latency_ms: turn.latency_ms, cited_labels: cited.map((c) => c!.label),
      answer_text: answer ? answer.segments.map((s) => s.text).join(" ") : (turn.message ?? ""),
    };
    rows.push(row);
    if (!declined) {
      grading.push(`## ${g.id} (${g.kind}) — ${g.question}`, "", `**Answer (${turn.outcome}):** ${row.answer_text}`, "", ...cited.map((c) => `- ${c!.label}: ${(c!.text || c!.visual_description || "").replace(/\s+/g, " ").slice(0, 400)}`), "");
    }
    console.log(`${g.id.padEnd(6)} ${g.kind.padEnd(12)} ${turn.outcome.padEnd(22)} hit@5=${hit}`);
  }

  const gradesPath = path.join(DOCS, "kb-eval-grades.json");
  const grades = existsSync(gradesPath) ? (JSON.parse(readFileSync(gradesPath, "utf8")) as Record<string, boolean>) : {};
  const agg = aggregate(rows, grades);
  const at = new Date().toISOString();
  await mkdir(DOCS, { recursive: true });
  await writeFile(path.join(DOCS, "kb-eval-report.md"), renderReport(agg, rows, { at, llm: llmEnabled(), gold: gold.length }));
  await writeFile(path.join(DOCS, "kb-eval-results.json"), JSON.stringify({ at, llm_enabled: llmEnabled(), gold_count: gold.length, metrics: agg, per_question: rows }, null, 2));
  await writeFile(path.join(DOCS, "kb-eval-grading.md"), grading.join("\n"));
  console.log(`\nWrote docs/kb-eval-report.md, docs/kb-eval-results.json, docs/kb-eval-grading.md`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
