/**
 * Flips `reviewed: false` → `reviewed: true`. A deliberate, separate step: questions may only be marked
 * reviewed after an actual human has read the answer keys and explanations ("never fake correctness").
 *
 *   npx tsx src/scripts/mark-reviewed.ts dsa              seed questions in seed/data/questions.dsa.json
 *   npm run mark:reviewed -- --kb dsa --list              print every unreviewed KB-generated question with its key and evidence
 *   npm run mark:reviewed -- --kb dsa --reject <id> ...   delete questions whose key is wrong
 *   npm run mark:reviewed -- --kb dsa --approve           mark all remaining unreviewed KB-generated questions reviewed
 */
import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname, "../db/seed/data");

async function kbMode(subject: string, args: string[]) {
  const { and, eq, inArray } = await import("drizzle-orm");
  const { db, pool } = await import("../db/client.js");
  const { questions, sourceChunks } = await import("../db/schema.js");
  try {
    const rejectIdx = args.indexOf("--reject");
    if (rejectIdx !== -1) {
      const ids = args.slice(rejectIdx + 1).filter((a) => !a.startsWith("--"));
      if (ids.length) await db.delete(questions).where(and(eq(questions.origin, "kb_generated"), inArray(questions.id, ids)));
      console.log(`Deleted ${ids.length} question(s).`);
    }
    const pending = await db.select({ q: questions, chunkText: sourceChunks.text, visual: sourceChunks.visualDescription })
      .from(questions).leftJoin(sourceChunks, eq(sourceChunks.id, questions.sourceChunkId))
      .where(and(eq(questions.subjectId, subject), eq(questions.origin, "kb_generated"), eq(questions.reviewed, false)));
    if (args.includes("--list")) {
      for (const { q, chunkText, visual } of pending) {
        const opts = (q.options as string[]).map((o, i) => `   ${i === q.correctIndex ? "✔" : " "} ${"ABCD"[i]}. ${o}`).join("\n");
        console.log(`\n[${q.id}] ${q.subtopicId} · concept ${q.conceptId ?? "-"} · difficulty ${q.difficulty}\n${q.stem}\n${opts}\n   why: ${q.explanation}\n   evidence: "${q.evidenceQuote}"\n   source ${q.sourceChunkId}: ${(chunkText || visual || "").slice(0, 240).replace(/\s+/g, " ")}`);
      }
      console.log(`\n${pending.length} unreviewed. Reject wrong ones with --reject <id> …, then --approve.`);
    }
    if (args.includes("--approve")) {
      console.log("Only run this after an actual human has read every answer key and explanation.");
      const res = await db.update(questions).set({ reviewed: true }).where(and(eq(questions.subjectId, subject), eq(questions.origin, "kb_generated"), eq(questions.reviewed, false)));
      console.log(`Marked ${res.rowCount ?? pending.length} KB-generated question(s) reviewed.`);
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const kbIdx = args.indexOf("--kb");
  if (kbIdx !== -1) {
    const subject = args[kbIdx + 1];
    if (!subject) throw new Error("Usage: mark-reviewed --kb <subject-id> [--list] [--reject id…] [--approve]");
    return kbMode(subject, args);
  }

  const subject = args[0];
  if (!subject) {
    console.error("Usage: npx tsx src/scripts/mark-reviewed.ts <subject-id>");
    process.exit(1);
  }

  const file = path.join(DATA_DIR, `questions.${subject}.json`);
  const questions = JSON.parse(await readFile(file, "utf-8"));

  console.log(`Marking ${questions.length} questions in ${file} as reviewed=true.`);
  console.log("Only run this after an actual human has read the answer keys and explanations.");

  for (const q of questions) q.reviewed = true;
  await writeFile(file, JSON.stringify(questions, null, 2));

  console.log("Done. Re-run `npm run seed` to push the change into Postgres.");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
