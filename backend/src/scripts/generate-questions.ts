/**
 * Offline question-generation pipeline (bloom-architecture-plan.md §17 build brief, §6.2).
 *
 * Reads the frozen content spec (seed/data/{subjects,topics,subtopics}.json), and for every
 * subtopic × difficulty bucket asks Gemini for a batch of MCQs, validates them against the
 * generation constraints, and writes to seed/data/questions.<subject>.json for human review —
 * never straight into Postgres.
 *
 * Resumable: re-running skips (subtopic, difficulty) buckets already present in the output
 * file, so a rate-limit failure partway through doesn't cost you the whole run.
 *
 * `reviewed` is always written `false` here. Flipping DSA questions to `reviewed: true` is a
 * separate, deliberate step (scripts/mark-reviewed.ts) that only happens after an actual human
 * has read the answer keys — see the non-negotiable rule in the Phase 1 brief §2.
 */
import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { generateJson, sleep } from "../lib/llmClient.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../db/seed/data");

const DIFFICULTY_BUCKETS: Array<{ label: string; difficulty: number; count: number }> = [
  { label: "easy", difficulty: 1, count: 8 },
  { label: "medium", difficulty: 3, count: 10 },
  { label: "hard", difficulty: 5, count: 6 },
];

const QuestionSchema = z.object({
  stem: z.string().min(10),
  options: z.array(z.string().min(1)).length(4),
  correct_index: z.number().int().min(0).max(3),
  explanation: z.string().min(20),
  concept: z.string().min(1),
});
const BatchSchema = z.object({ questions: z.array(QuestionSchema) });

type Subtopic = {
  id: string;
  topicId: string;
  name: string;
  description: string;
  concepts: string[];
};
type Topic = { id: string; subjectId: string; name: string };

type StoredQuestion = {
  id: string;
  subjectId: string;
  topicId: string;
  subtopicId: string;
  conceptId: string | null;
  difficulty: number;
  stem: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  reviewed: boolean;
};

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf-8"));
}

function forbiddenPhrase(stem: string, options: string[]): boolean {
  const banned = /\ball of the above\b|\bnone of the above\b/i;
  return banned.test(stem) || options.some((o) => banned.test(o));
}

async function generateForSubtopic(
  subject: { id: string; name: string },
  topic: Topic,
  subtopic: Subtopic,
  bucket: { label: string; difficulty: number; count: number },
  startIndex: number,
): Promise<StoredQuestion[]> {
  const systemPrompt = `You are writing multiple-choice questions for a computer science learning platform.
Follow these rules exactly:
- Exactly one option is unambiguously correct.
- The other three options are real misconceptions a student could plausibly hold, not filler or joke answers.
- Never use "all of the above" or "none of the above" as an option.
- The explanation must state why the correct answer is right AND why the single most tempting
  distractor is wrong.
- Every question must be tagged with exactly one concept from the provided list — pick the one
  it most directly tests.
- Output strict JSON only, matching the requested schema.`;

  const userPrompt = `Subject: ${subject.name}
Topic: ${topic.name}
Subtopic: ${subtopic.name} — ${subtopic.description}
Allowed concept tags (choose exactly one per question): ${JSON.stringify(subtopic.concepts)}
Difficulty level: ${bucket.label} (on a 1-5 scale, this is level ${bucket.difficulty})

Generate exactly ${bucket.count} multiple-choice questions at this difficulty level for this subtopic.

Return JSON of the shape:
{ "questions": [ { "stem": string, "options": [string, string, string, string], "correct_index": 0-3, "explanation": string, "concept": string } ] }`;

  const raw = await generateJson<unknown>({ systemPrompt, userPrompt, temperature: 0.5, maxOutputTokens: 4096 });
  const parsed = BatchSchema.parse(raw);

  const accepted: StoredQuestion[] = [];
  for (const [i, q] of parsed.questions.entries()) {
    if (forbiddenPhrase(q.stem, q.options)) continue;
    if (!subtopic.concepts.includes(q.concept)) continue;

    accepted.push({
      // A partially accepted batch must be resumable.  Start after the IDs
      // already persisted for this exact subtopic/difficulty instead of
      // reusing __easy__0 etc. on the next invocation.
      id: `${subtopic.id}__${bucket.label}__${startIndex + i}`,
      subjectId: subject.id,
      topicId: topic.id,
      subtopicId: subtopic.id,
      conceptId: `${subtopic.id}__${q.concept}`,
      difficulty: bucket.difficulty,
      stem: q.stem,
      options: q.options,
      correctIndex: q.correct_index,
      explanation: q.explanation,
      reviewed: false,
    });
  }
  return accepted;
}

async function main() {
  // v4 §N6.1: `npm run generate:questions -- --from-kb dsa` writes MCQs grounded in the knowledge base to the DB.
  const kbIdx = process.argv.indexOf("--from-kb");
  if (kbIdx !== -1) {
    const subject = process.argv[kbIdx + 1];
    if (!subject) throw new Error("Usage: generate:questions -- --from-kb <subject-id>");
    const { generateFromKb, formatReport } = await import("../kb/questions/generate.js");
    const { pool } = await import("../db/client.js");
    try {
      const report = await generateFromKb(subject, { log: console.log });
      console.log("\n" + formatReport(report));
      console.log("Stored with reviewed=false. Read every answer key, then: npm run mark:reviewed -- --kb " + subject);
    } finally {
      await pool.end();
    }
    return;
  }
  const subjectFilter = process.argv[2]; // optional: `npm run generate:questions -- dsa`

  const subjects = await loadJson<Array<{ id: string; name: string }>>("subjects.json");
  const topics = await loadJson<Topic[]>("topics.json");
  const subtopics = await loadJson<Subtopic[]>("subtopics.json");

  const subjectsToRun = subjectFilter ? subjects.filter((s) => s.id === subjectFilter) : subjects;

  for (const subject of subjectsToRun) {
    const outFile = path.join(DATA_DIR, `questions.${subject.id}.json`);
    let existing: StoredQuestion[] = [];
    try {
      existing = JSON.parse(await readFile(outFile, "utf-8"));
    } catch {
      // no existing file yet — fine
    }
    const subjectTopics = topics.filter((t) => t.subjectId === subject.id);
    const subjectSubtopics = subtopics.filter((st) => subjectTopics.some((t) => t.id === st.topicId));

    console.log(`\n=== ${subject.name} (${subjectSubtopics.length} subtopics) ===`);

    for (const subtopic of subjectSubtopics) {
      const topic = subjectTopics.find((t) => t.id === subtopic.topicId)!;

      for (const bucket of DIFFICULTY_BUCKETS) {
        const alreadyGenerated = existing.filter(
          (q) => q.subtopicId === subtopic.id && q.difficulty === bucket.difficulty,
        );
        const remaining = Math.max(0, bucket.count - alreadyGenerated.length);
        if (remaining === 0) {
          console.log(`  skip  ${subtopic.id} [${bucket.label}] — ${alreadyGenerated.length}/${bucket.count} already generated`);
          continue;
        }

        process.stdout.write(`  gen   ${subtopic.id} [${bucket.label}] — ${alreadyGenerated.length}/${bucket.count} present... `);
        try {
          const batch = await generateForSubtopic(subject, topic, subtopic, { ...bucket, count: remaining }, alreadyGenerated.length);
          existing.push(...batch);
          console.log(`${batch.length}/${remaining} accepted`);
          await mkdir(DATA_DIR, { recursive: true });
          await writeFile(outFile, JSON.stringify(existing, null, 2));
        } catch (err) {
          console.log(`FAILED — ${(err as Error).message}`);
          console.log(`  (safe to re-run — already-generated buckets are skipped)`);
        }

        await sleep(4000); // stay well under free-tier RPM limits
      }
    }

    console.log(`Wrote ${existing.length} questions to ${outFile}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
