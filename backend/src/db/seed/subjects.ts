import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../client.js";
import { subjects, topics, subtopics, topicPrerequisites, subtopicPrerequisites, concepts } from "../schema.js";
import { sql } from "drizzle-orm";

const DATA_DIR = path.resolve(import.meta.dirname, "data");

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf-8"));
}

export async function seedDomain() {
  const subjectsData = await loadJson<Array<{ id: string; name: string }>>("subjects.json");
  const topicsData = await loadJson<Array<{ id: string; subjectId: string; name: string; weight: number; baseHours: number; difficulty: number }>>("topics.json");
  const subtopicsData = await loadJson<Array<{
    id: string; topicId: string; name: string; weight: number; baseHours: number; difficulty: number;
    description: string; concepts: string[];
  }>>("subtopics.json");
  const prereqData = await loadJson<{
    topic: Array<{ topicId: string; prereqId: string }>;
    subtopic: Array<{ subtopicId: string; prereqId: string }>;
  }>("prerequisites.json");

  await db
    .insert(subjects)
    .values(subjectsData)
    .onConflictDoUpdate({ target: subjects.id, set: { name: sql`excluded.name` } });
  console.log(`  subjects: ${subjectsData.length}`);

  await db
    .insert(topics)
    .values(topicsData.map((t) => ({ ...t, weight: String(t.weight), baseHours: String(t.baseHours) })))
    .onConflictDoUpdate({
      target: topics.id,
      set: {
        name: sql`excluded.name`,
        weight: sql`excluded.weight`,
        baseHours: sql`excluded.base_hours`,
        difficulty: sql`excluded.difficulty`,
      },
    });
  console.log(`  topics: ${topicsData.length}`);

  await db
    .insert(subtopics)
    .values(
      subtopicsData.map((st) => ({
        id: st.id,
        topicId: st.topicId,
        name: st.name,
        weight: String(st.weight),
        baseHours: String(st.baseHours),
        difficulty: st.difficulty,
        description: st.description,
      })),
    )
    .onConflictDoUpdate({
      target: subtopics.id,
      set: {
        name: sql`excluded.name`,
        weight: sql`excluded.weight`,
        baseHours: sql`excluded.base_hours`,
        difficulty: sql`excluded.difficulty`,
        description: sql`excluded.description`,
      },
    });
  console.log(`  subtopics: ${subtopicsData.length}`);

  const conceptRows = subtopicsData.flatMap((st) =>
    st.concepts.map((name) => ({ id: `${st.id}__${name}`, subtopicId: st.id, name })),
  );
  await db
    .insert(concepts)
    .values(conceptRows)
    .onConflictDoUpdate({ target: concepts.id, set: { name: sql`excluded.name` } });
  console.log(`  concepts: ${conceptRows.length}`);

  if (prereqData.topic.length > 0) {
    await db
      .insert(topicPrerequisites)
      .values(prereqData.topic.map((p) => ({ topicId: p.topicId, prereqId: p.prereqId })))
      .onConflictDoNothing();
  }
  if (prereqData.subtopic.length > 0) {
    await db
      .insert(subtopicPrerequisites)
      .values(prereqData.subtopic.map((p) => ({ subtopicId: p.subtopicId, prereqId: p.prereqId })))
      .onConflictDoNothing();
  }
  console.log(`  prerequisite edges: ${prereqData.topic.length} topic + ${prereqData.subtopic.length} subtopic`);

  return { subjectsData, topicsData, subtopicsData };
}
