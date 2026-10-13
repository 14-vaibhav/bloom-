import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../client.js";
import { questions, concepts } from "../schema.js";

const DATA_DIR = path.resolve(import.meta.dirname, "data");

type QuestionJson = {
  id: string; subjectId: string; topicId: string; subtopicId: string;
  conceptId: string | null; difficulty: number; stem: string;
  options: string[]; correctIndex: number; explanation: string; reviewed: boolean;
};

async function loadJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf-8"));
  } catch {
    return null;
  }
}

const SUBJECT_FILES = ["questions.dsa.json", "questions.cn.json", "questions.rdbms.json", "questions.oop.json"];

export async function seedQuestions() {
  let total = 0;

  // concept ids referenced by questions must exist — build the known-good set once.
  const knownConceptIds = new Set((await db.select({ id: concepts.id }).from(concepts)).map((c) => c.id));

  for (const file of SUBJECT_FILES) {
    const data = await loadJson<QuestionJson[]>(file);
    if (!data || data.length === 0) continue;

    const rows = data.map((q) => ({
      id: q.id,
      subjectId: q.subjectId,
      topicId: q.topicId,
      subtopicId: q.subtopicId,
      conceptId: q.conceptId && knownConceptIds.has(q.conceptId) ? q.conceptId : null,
      difficulty: q.difficulty,
      stem: q.stem,
      options: q.options,
      correctIndex: q.correctIndex,
      explanation: q.explanation,
      reviewed: q.reviewed,
    }));

    for (const row of rows) {
      await db
        .insert(questions)
        .values(row)
        .onConflictDoUpdate({
          target: questions.id,
          set: {
            stem: sql`excluded.stem`,
            options: sql`excluded.options`,
            correctIndex: sql`excluded.correct_index`,
            explanation: sql`excluded.explanation`,
            difficulty: sql`excluded.difficulty`,
            conceptId: sql`excluded.concept_id`,
            reviewed: sql`excluded.reviewed`,
          },
        });
    }
    total += rows.length;
    console.log(`  ${file}: ${rows.length}`);
  }

  if (total === 0) {
    console.log("  no question JSON files found yet — run `npm run generate:questions` first.");
  }
  return total;
}
