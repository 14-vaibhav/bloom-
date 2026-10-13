import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { subtopicMastery, tutorTurns } from "../../src/db/schema.js";
import { retrievalHooks } from "../../src/kb/retrieval.js";
import { armBreakCitation, disarmBreakCitation } from "../../src/tutor/breakCitation.js";
import { askTutor } from "../../src/tutor/tutor.js";
import type { TutorAnswer } from "../../src/tutor/citationValidator.js";
import { getDemoStudentId, resetToolHealth } from "../tools/helpers.js";
import { cleanFakeKb, cleanTutorRows, fakeEmbedQuery, seedFakeKb, SLIDES, VIDEO } from "./helpers.js";

let studentId: string;
const ask = (question: string, generate?: (i: any) => Promise<TutorAnswer>) =>
  askTutor({ studentId, question, deps: { generate, assetExists: () => true } });

const grounded: TutorAnswer = {
  segments: [
    { text: "A singly linked list keeps each element in a node, and every node points at the next node in the list.", chunk_ids: [`${VIDEO}:0`], quote: "every node holds a pointer to the next node, so inserting at the head" },
    { text: "On the slide, the last arrow points to NULL which marks the end of the list.", chunk_ids: [`${SLIDES}:0`], quote: "the last arrow points to NULL" },
  ],
};
const Q = "how does a singly linked list store the next pointer in each node";

beforeAll(async () => {
  studentId = await getDemoStudentId();
  await seedFakeKb();
  retrievalHooks.embedQuery = fakeEmbedQuery;
  retrievalHooks.evidenceSim = 0.2;
  await resetToolHealth("kb");
});
beforeEach(async () => { disarmBreakCitation(); await cleanTutorRows(studentId); });
afterAll(async () => {
  retrievalHooks.embedQuery = undefined; retrievalHooks.evidenceSim = undefined;
  await cleanTutorRows(studentId); await cleanFakeKb(); await resetToolHealth("kb"); delete process.env.LLM_ENABLED;
});

describe("tutor pipeline", () => {
  it("answers with validated, cited segments and records the turn", async () => {
    const r = await ask(Q, async () => grounded);
    expect(r.outcome).toBe("answered");
    expect(r.validation?.passed).toBe(true);
    expect(r.repair_rounds).toBe(0);
    expect(r.subtopic_ids[0]).toBe("ll_singly");
    expect(r.chunks.map((c) => c.kind)).toContain("slides");
    const [row] = await db.select().from(tutorTurns).where(eq(tutorTurns.id, r.turn_id));
    expect(row.outcome).toBe("answered");
    expect(row.retrievedChunkIds.length).toBeGreaterThan(0);
  });

  it("rejects an invented citation, repairs once, and shows the repaired answer", async () => {
    armBreakCitation();
    let calls = 0;
    const r = await ask(Q, async (input) => { calls++; if (calls === 2) expect(input.prior_failures?.[0]).toMatch(/K2/); return grounded; });
    expect(calls).toBe(2);
    expect(r.repair_rounds).toBe(1);
    expect(r.outcome).toBe("answered");
    expect(r.answer?.segments.flatMap((s) => s.chunk_ids)).not.toContain("invented:999");
  });

  it("falls back to an extractive answer when the repair also fails", async () => {
    const bad: TutorAnswer = { segments: [{ text: "x", chunk_ids: ["nope:1"], quote: "made up words that appear nowhere in the course at all" }] };
    const r = await ask(Q, async () => bad);
    expect(r.outcome).toBe("extractive_fallback");
    expect(r.repair_rounds).toBe(1);
    expect(r.validation?.passed).toBe(true);
    expect(r.answer?.segments.length).toBeGreaterThan(0);
  });

  it("returns an extractive answer when the LLM is disabled", async () => {
    process.env.LLM_ENABLED = "false";
    try {
      const r = await askTutor({ studentId, question: Q, deps: { assetExists: () => true } });
      expect(r.outcome).toBe("extractive_fallback");
      expect(r.notices).toContain("LLM unavailable — extractive answer returned.");
      expect(r.validation?.passed).toBe(true);
    } finally { delete process.env.LLM_ENABLED; }
  });

  it("declines, with the nearest passages, when nothing in the course supports the question", async () => {
    retrievalHooks.evidenceSim = 0.9;
    try {
      const r = await ask("quantum chromodynamics gluon confinement", async () => { throw new Error("must not be called"); });
      expect(r.outcome).toBe("declined_no_evidence");
      expect(r.answer).toBeNull();
      expect(r.nearest.length).toBeGreaterThan(0);
    } finally { retrievalHooks.evidenceSim = 0.2; }
  });

  it("declines when the model says the passages do not answer it", async () => {
    const r = await ask(Q, async () => ({ segments: [], follow_up: null }));
    expect(r.outcome).toBe("declined_no_evidence");
  });

  it("declines, never answering uncited, when the knowledge base is down", async () => {
    const { toolHealth } = await import("../../src/db/schema.js");
    await db.update(toolHealth).set({ state: "open", openedAt: new Date(), consecutiveFailures: 3 }).where(eq(toolHealth.toolName, "kb"));
    try {
      const r = await ask(Q, async () => grounded);
      expect(r.outcome).toBe("declined_kb_down");
      expect(r.answer).toBeNull();
      expect(r.notices.join(" ")).toContain("Knowledge base unavailable");
    } finally { await resetToolHealth("kb"); }
  });

  it("picks the mode from mastery and does not write mastery", async () => {
    const before = await db.select().from(subtopicMastery).where(eq(subtopicMastery.studentId, studentId));
    const r = await ask(Q, async () => grounded);
    expect(["explain", "connect", "challenge"]).toContain(r.mode);
    const after = await db.select().from(subtopicMastery).where(eq(subtopicMastery.studentId, studentId));
    expect(after).toEqual(before);
  });
});
