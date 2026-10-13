import { describe, it, expect, beforeAll } from "vitest";
import { db, pool } from "../src/db/client.js";
import {
  subjects, topics, subtopics, subtopicPrerequisites, topicPrerequisites,
  concepts, questions, resources, toolHealth,
} from "../src/db/schema.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname, "../src/db/seed/data");

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf-8"));
}

describe("domain content", () => {
  it("has all four subjects", async () => {
    const rows = await db.select().from(subjects);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["cn", "dsa", "oop", "rdbms"]);
  });

  it("has the expected topic/subtopic counts per subject", async () => {
    const topicRows = await db.select().from(topics);
    const subtopicRows = await db.select().from(subtopics);

    const byTopicSubject = (subjectId: string) => topicRows.filter((t) => t.subjectId === subjectId).length;
    expect(byTopicSubject("dsa")).toBe(6);
    expect(byTopicSubject("cn")).toBe(2);
    expect(byTopicSubject("rdbms")).toBe(2);
    expect(byTopicSubject("oop")).toBe(2);

    const dsaTopicIds = topicRows.filter((t) => t.subjectId === "dsa").map((t) => t.id);
    const dsaSubtopicCount = subtopicRows.filter((st) => dsaTopicIds.includes(st.topicId)).length;
    expect(dsaSubtopicCount).toBe(25);
    expect(subtopicRows.length).toBe(43);
  });

  it("has sibling weights summing to 1.0 (±0.001) within every topic", async () => {
    const subtopicRows = await db.select().from(subtopics);
    const byTopic = new Map<string, number>();
    for (const st of subtopicRows) {
      byTopic.set(st.topicId, (byTopic.get(st.topicId) ?? 0) + Number(st.weight));
    }
    for (const [topicId, sum] of byTopic) {
      expect(sum, `subtopic weights under topic ${topicId}`).toBeCloseTo(1.0, 3);
    }
  });

  it("has sibling topic weights summing to 1.0 (±0.001) within every subject", async () => {
    const topicRows = await db.select().from(topics);
    const bySubject = new Map<string, number>();
    for (const t of topicRows) {
      bySubject.set(t.subjectId, (bySubject.get(t.subjectId) ?? 0) + Number(t.weight));
    }
    for (const [subjectId, sum] of bySubject) {
      expect(sum, `topic weights under subject ${subjectId}`).toBeCloseTo(1.0, 3);
    }
  });

  it("every prerequisite edge references rows that exist", async () => {
    const subtopicIds = new Set((await db.select({ id: subtopics.id }).from(subtopics)).map((r) => r.id));
    const topicIds = new Set((await db.select({ id: topics.id }).from(topics)).map((r) => r.id));

    const subtopicPrereqs = await db.select().from(subtopicPrerequisites);
    for (const p of subtopicPrereqs) {
      expect(subtopicIds.has(p.subtopicId)).toBe(true);
      expect(subtopicIds.has(p.prereqId)).toBe(true);
    }

    const topicPrereqs = await db.select().from(topicPrerequisites);
    for (const p of topicPrereqs) {
      expect(topicIds.has(p.topicId)).toBe(true);
      expect(topicIds.has(p.prereqId)).toBe(true);
    }
  });

  it("subtopic prerequisite graph is a DAG (no cycles)", async () => {
    const edges = await db.select().from(subtopicPrerequisites);
    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      // edge means "prereqId must come before subtopicId" → traverse subtopicId -> prereqId
      if (!adjacency.has(e.subtopicId)) adjacency.set(e.subtopicId, []);
      adjacency.get(e.subtopicId)!.push(e.prereqId);
    }

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    let cycleFound = false;

    function visit(node: string) {
      if (cycleFound) return;
      color.set(node, GRAY);
      for (const next of adjacency.get(node) ?? []) {
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) {
          cycleFound = true;
          return;
        }
        if (c === WHITE) visit(next);
      }
      color.set(node, BLACK);
    }

    for (const node of adjacency.keys()) {
      if ((color.get(node) ?? WHITE) === WHITE) visit(node);
    }

    expect(cycleFound).toBe(false);
  });

  it("topic prerequisite graph is a DAG (no cycles)", async () => {
    const edges = await db.select().from(topicPrerequisites);
    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      if (!adjacency.has(e.topicId)) adjacency.set(e.topicId, []);
      adjacency.get(e.topicId)!.push(e.prereqId);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    let cycleFound = false;
    function visit(node: string) {
      if (cycleFound) return;
      color.set(node, GRAY);
      for (const next of adjacency.get(node) ?? []) {
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) { cycleFound = true; return; }
        if (c === WHITE) visit(next);
      }
      color.set(node, BLACK);
    }
    for (const node of adjacency.keys()) {
      if ((color.get(node) ?? WHITE) === WHITE) visit(node);
    }
    expect(cycleFound).toBe(false);
  });
});

describe("questions", () => {
  it("every subtopic has at least 20 questions", async () => {
    const subtopicRows = await db.select().from(subtopics);
    const questionRows = await db.select().from(questions);
    const countBySubtopic = new Map<string, number>();
    for (const q of questionRows) {
      countBySubtopic.set(q.subtopicId, (countBySubtopic.get(q.subtopicId) ?? 0) + 1);
    }
    const short = subtopicRows.filter((st) => (countBySubtopic.get(st.id) ?? 0) < 20);
    expect(
      short.length,
      `subtopics with <20 questions: ${short.map((s) => `${s.id} (${countBySubtopic.get(s.id) ?? 0})`).join(", ")}. ` +
        `Run \`npm run generate:questions\` (needs GEMINI_API_KEY) if this is 0/43.`,
    ).toBe(0);
  });

  it("every question's correct_index is within bounds of its options", async () => {
    const rows = await db.select().from(questions);
    for (const q of rows) {
      const options = q.options as string[];
      expect(q.correctIndex).toBeGreaterThanOrEqual(0);
      expect(q.correctIndex).toBeLessThan(options.length);
    }
  });

  it("every question's concept tag belongs to its own subtopic", async () => {
    const rows = await db.select().from(questions);
    const conceptRows = await db.select().from(concepts);
    const conceptBySubtopic = new Map<string, Set<string>>();
    for (const c of conceptRows) {
      if (!conceptBySubtopic.has(c.subtopicId)) conceptBySubtopic.set(c.subtopicId, new Set());
      conceptBySubtopic.get(c.subtopicId)!.add(c.id);
    }
    for (const q of rows) {
      if (!q.conceptId) continue;
      expect(conceptBySubtopic.get(q.subtopicId)?.has(q.conceptId)).toBe(true);
    }
  });

  it("no two questions share an identical stem", async () => {
    const rows = await db.select({ stem: questions.stem }).from(questions);
    const stems = rows.map((r) => r.stem);
    expect(new Set(stems).size).toBe(stems.length);
  });

  it("all DSA questions are reviewed=true; all others are reviewed=false", async () => {
    const rows = await db.select().from(questions);
    const dsa = rows.filter((q) => q.subjectId === "dsa");
    const others = rows.filter((q) => q.subjectId !== "dsa");
    for (const q of dsa) expect(q.reviewed, q.id).toBe(true);
    for (const q of others) expect(q.reviewed, q.id).toBe(false);
  });
});

describe("resources", () => {
  it("every resource has at least one valid subtopic_id and is_live=true", async () => {
    const rows = await db.select().from(resources);
    const subtopicIds = new Set((await db.select({ id: subtopics.id }).from(subtopics)).map((r) => r.id));
    for (const r of rows) {
      expect(r.subtopicIds.length, r.id).toBeGreaterThan(0);
      for (const sid of r.subtopicIds) {
        expect(subtopicIds.has(sid), `${r.id} references unknown subtopic ${sid}`).toBe(true);
      }
      expect(r.isLive, `${r.id} (${r.url})`).toBe(true);
    }
  });
});

describe("eval profiles", () => {
  it("has exactly five schema-valid profiles", async () => {
    const profiles = await loadJson<
      Array<{ name: string; true_learn_rate: number; attendance_probability: number; noise_sigma: number; true_mastery_base: number }>
    >("eval-profiles.json");
    expect(profiles.length).toBe(5);
    for (const p of profiles) {
      expect(typeof p.name).toBe("string");
      expect(p.true_learn_rate).toBeGreaterThan(0);
      expect(p.attendance_probability).toBeGreaterThan(0);
      expect(p.attendance_probability).toBeLessThanOrEqual(1);
    }
  });
});

describe("tool_health", () => {
  it("has exactly one row per tool, all closed", async () => {
    const rows = await db.select().from(toolHealth);
    expect(rows.length).toBe(7);
    for (const r of rows) expect(r.state).toBe("closed");
    const names = rows.map((r) => r.toolName).sort();
    expect(names).toEqual(["calendar", "kb", "llm", "performance", "qbank", "rag", "state"]);
  });
});
