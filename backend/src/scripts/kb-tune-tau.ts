/**
 * Tunes the tagging threshold τ on hand-labelled chunks (v4 §N1.4).
 *
 *   npm run kb:tune-tau -- --export dsa [n=30]   writes kb-data/tag-labels.json with n random tagged-or-not chunks,
 *                                                the tagger's suggestion pre-filled in "suggested" and "subtopic_id": null
 *   (edit it: set "subtopic_id" to the true subtopic, or "none" if the chunk is off-topic)
 *   npm run kb:tune-tau                          prints precision / recall per τ and the best τ by F1
 */
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { BACKEND_ROOT } from "../kb/ingest/run.js";
import { buildSubtopicIndex, cosine, parseVector, TAG_SECOND_MARGIN } from "../kb/ingest/tagger.js";

const FILE = path.join(BACKEND_ROOT, "kb-data", "tag-labels.json");
type Label = { chunk_id: string; text: string; suggested: string[]; subtopic_id: string | null };

async function main() {
  const args = process.argv.slice(2);
  const exportIdx = args.indexOf("--export");
  if (exportIdx !== -1) {
    const subject = args[exportIdx + 1];
    const n = Number(args[exportIdx + 2] ?? 30);
    const rows = await db.execute<{ id: string; text: string; visual_description: string | null; subtopic_ids: string[] }>(sql`
      select c.id, c.text, c.visual_description, c.subtopic_ids from source_chunks c join sources s on s.id = c.source_id
      where s.subject_id = ${subject} and not c.low_information order by random() limit ${n}`);
    await mkdir(path.dirname(FILE), { recursive: true });
    const labels: Label[] = rows.rows.map((r) => ({ chunk_id: r.id, text: `${r.text} ${r.visual_description ?? ""}`.trim().slice(0, 300), suggested: r.subtopic_ids, subtopic_id: null }));
    await writeFile(FILE, JSON.stringify(labels, null, 2));
    console.log(`Wrote ${labels.length} chunks to ${FILE}. Fill in "subtopic_id" ("none" if off-topic), then run without --export.`);
    return;
  }

  const labels = (JSON.parse(await readFile(FILE, "utf8")) as Label[]).filter((l) => l.subtopic_id);
  if (labels.length === 0) throw new Error("No labelled chunks — fill in subtopic_id in kb-data/tag-labels.json first.");
  const subject = (await db.execute<{ subject_id: string }>(sql`select s.subject_id from source_chunks c join sources s on s.id = c.source_id where c.id = ${labels[0].chunk_id}`)).rows[0].subject_id;
  const idx = await buildSubtopicIndex(subject);
  const embs = new Map<string, number[]>();
  for (const l of labels) {
    const r = await db.execute<{ e: string }>(sql`select embedding::text as e from source_chunks where id = ${l.chunk_id}`);
    embs.set(l.chunk_id, parseVector(r.rows[0].e));
  }
  console.log("τ      tagged  precision  recall  F1");
  let best = { tau: 0, f1: -1 };
  for (let tau = 0.4; tau <= 0.85; tau += 0.025) {
    let tagged = 0, correct = 0, relevant = 0;
    for (const l of labels) {
      const ranked = idx.subtopicVecs.map((s) => ({ id: s.id, sim: cosine(embs.get(l.chunk_id)!, s.vec) })).sort((a, b) => b.sim - a.sim);
      const chosen = ranked[0].sim >= tau ? [ranked[0].id, ...(ranked[1] && ranked[1].sim >= tau && ranked[0].sim - ranked[1].sim <= TAG_SECOND_MARGIN ? [ranked[1].id] : [])] : [];
      if (l.subtopic_id !== "none") relevant++;
      if (chosen.length) { tagged++; if (chosen.includes(l.subtopic_id!)) correct++; }
    }
    const precision = tagged ? correct / tagged : 0;
    const recall = relevant ? correct / relevant : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    if (f1 > best.f1) best = { tau, f1 };
    console.log(`${tau.toFixed(3)}  ${String(tagged).padStart(6)}  ${precision.toFixed(2).padStart(9)}  ${recall.toFixed(2).padStart(6)}  ${f1.toFixed(2)}`);
  }
  console.log(`\nBest τ by F1 on ${labels.length} labelled chunks: ${best.tau.toFixed(3)} (F1 ${best.f1.toFixed(2)}). Set KB_TAG_TAU=${best.tau.toFixed(3)} and re-run ingestion, then record the precision in the ingest report.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => pool.end());
