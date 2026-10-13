import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { assessments, questionAttempts, questionState, questions, sourceChunks } from "../../src/db/schema.js";
import { acceptQuestion, generateFromKb, type RawQuestion } from "../../src/kb/questions/generate.js";
import { reviewSourcesFor } from "../../src/kb/reviewSources.js";
import { createUntrackedContext } from "../../src/tools/context.js";
import { callTool } from "../../src/tools/dispatcher.js";
import { getDemoStudentId } from "../tools/helpers.js";
import { BOOK, cleanFakeKb, seedFakeKb, SLIDES, VIDEO } from "./helpers.js";

const chunk = { text: "A singly linked list stores each element in a node and every node holds a pointer to the next node, so inserting at the head takes constant time.", visualDescription: null };
const good: RawQuestion = {
  stem: "What does every node of a singly linked list hold besides its value?", options: ["A pointer to the next node", "A pointer to the previous node", "The list length", "A hash of the value"],
  correct_index: 0, explanation: "Each node holds a pointer to the next node.", concept_id: null, difficulty: 2,
  evidence_quote: "every node holds a pointer to the next node, so inserting at the head",
};

describe("acceptQuestion (the evidence-quote gate)", () => {
  it("accepts a question whose quote is in the chunk", () => {
    const r = acceptQuestion(good, chunk, []);
    expect(r.ok).toBe(true);
  });
  it("discards a quote that is not in the chunk, wrong length quotes, bad shapes, duplicates and banned phrases", () => {
    const reason = (q: RawQuestion) => { const r = acceptQuestion(q, chunk, ["c1"]); return r.ok ? "ok" : r.reason; };
    expect(reason({ ...good, evidence_quote: "a doubly linked list keeps two pointers per node always" })).toBe("quote_not_in_chunk");
    expect(reason({ ...good, evidence_quote: "every node holds" })).toBe("quote_length");
    expect(reason({ ...good, options: ["a", "b", "c"] })).toBe("bad_shape");
    expect(reason({ ...good, correct_index: 4 })).toBe("bad_shape");
    expect(reason({ ...good, options: ["same", "Same!", "c", "d"] })).toBe("duplicate_options");
    expect(reason({ ...good, options: ["None of the above", "b", "c", "d"] })).toBe("banned_phrase");
    expect(reason({ ...good, concept_id: "nonexistent" })).toBe("unknown_concept");
  });
});

describe("generateFromKb + reviewed_only + review_sources", () => {
  beforeAll(async () => { await seedFakeKb(); });
  afterAll(async () => {
    await db.delete(questionAttempts).where(like(questionAttempts.questionId, "kbq_tst_%"));
    await db.delete(questionState).where(like(questionState.questionId, "kbq_tst_%"));
    await db.delete(questions).where(like(questions.id, "kbq_tst_%"));
    await db.delete(assessments).where(eq(assessments.studentId, await getDemoStudentId()));
    await cleanFakeKb();
  });

  it("stores only accepted questions, unreviewed, with provenance — and counts what it discarded", async () => {
    await db.update(sourceChunks).set({ tagSimilarity: "0.800" }).where(like(sourceChunks.id, "tst_%"));
    const generate = async (input: { passage: { chunk_id: string; text: string } }): Promise<RawQuestion[]> => {
      if (input.passage.chunk_id !== `${VIDEO}:0`) return [];
      return [good, { ...good, evidence_quote: "this exact sentence is nowhere in the passage at all" }];
    };
    const report = await generateFromKb("dsa", { generate: generate as never });
    expect(report.accepted).toBe(1);
    expect(report.rejected.quote_not_in_chunk).toBe(1);
    expect(report.stored).toBe(1);
    const rows = await db.select().from(questions).where(like(questions.id, "kbq_tst_%"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "kb_generated", reviewed: false, sourceChunkId: `${VIDEO}:0`, subtopicId: "ll_singly" });
    expect(rows[0].evidenceQuote).toBe(good.evidence_quote);
  });

  it("never serves an unreviewed question unless asked", async () => {
    const ctx = createUntrackedContext({ studentId: await getDemoStudentId() });
    const served = await callTool(ctx, "qbank.get_questions", { subtopic_ids: ["ll_singly"], count: 50, exclude_seen: false });
    expect(served.some((q) => q.question_id.startsWith("kbq_tst_"))).toBe(false);
    await db.update(questions).set({ reviewed: true }).where(like(questions.id, "kbq_tst_%"));
    const after = await callTool(ctx, "qbank.get_questions", { subtopic_ids: ["ll_singly"], count: 50, exclude_seen: false });
    expect(after.some((q) => q.question_id.startsWith("kbq_tst_"))).toBe(true);
    await db.update(questions).set({ reviewed: false }).where(like(questions.id, "kbq_tst_%"));
    const raw = await callTool(ctx, "qbank.get_questions", { subtopic_ids: ["ll_singly"], count: 50, exclude_seen: false, reviewed_only: false });
    expect(raw.some((q) => q.question_id.startsWith("kbq_tst_"))).toBe(true);
  });

  it("routes a wrong answer to its own source plus the best chunk of every other kind", async () => {
    const [q] = await db.select().from(questions).where(like(questions.id, "kbq_tst_%"));
    const r = await reviewSourcesFor([{ id: q.id, subtopicId: q.subtopicId, conceptId: q.conceptId, sourceChunkId: q.sourceChunkId }]);
    const list = r.review_sources[q.id];
    expect(list[0]).toMatchObject({ chunk_id: `${VIDEO}:0`, own: true, label: "Lecture 5 · 14:20" });
    expect(list.map((s) => s.kind).sort()).toEqual(["slides", "textbook", "video"]);
    expect(list.find((s) => s.kind === "textbook")).toMatchObject({ chunk_id: `${BOOK}:0`, label: "ODS · p. 44", own: false });
    expect(list.find((s) => s.kind === "slides")?.chunk_id).toBe(`${SLIDES}:0`);
  });

  it("hides source links, with a note, while the knowledge base is down", async () => {
    const { toolHealth } = await import("../../src/db/schema.js");
    await db.update(toolHealth).set({ state: "open", openedAt: new Date() }).where(eq(toolHealth.toolName, "kb"));
    try {
      const r = await reviewSourcesFor([{ id: "x", subtopicId: "ll_singly", conceptId: null, sourceChunkId: null }]);
      expect(r.review_sources).toEqual({});
      expect(r.review_sources_note).toContain("Knowledge base unavailable");
    } finally {
      await db.update(toolHealth).set({ state: "closed", openedAt: null, consecutiveFailures: 0 }).where(eq(toolHealth.toolName, "kb"));
    }
  });
});
