import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, like, sql } from "drizzle-orm";
import { createApp } from "../../src/app.js";
import { db } from "../../src/db/client.js";
import { learningActivities, resources, sourceChunks, studentConstraints, subtopicMastery } from "../../src/db/schema.js";
import { tick } from "../../src/agent/orchestrator.js";
import { getSimNow } from "../../src/agent/simClock.js";
import { buildSegments, groupSegments, segmentDurationMin, segmentLabel, type SegChunk } from "../../src/kb/ingest/segments.js";
import { getDemoStudentId } from "../tools/helpers.js";
import { BOOK, cleanFakeKb, seedFakeKb, VIDEO } from "./helpers.js";

const c = (seq: number, subtopic: string | null, loc: Record<string, unknown>, low = false): SegChunk => ({ id: `x:${seq}`, seq, subtopicIds: subtopic ? [subtopic] : [], conceptIds: [], locator: loc, text: "word ".repeat(50), heading: null, lowInformation: low });

describe("segment grouping (pure)", () => {
  const v = (seq: number, sub: string | null) => c(seq, sub, { t_start: seq * 75, t_end: seq * 75 + 75 });
  it("groups consecutive chunks with the same subtopic and breaks on changes, gaps and untagged chunks", () => {
    const segs = groupSegments("video", [v(0, "a"), v(1, "a"), v(2, "b"), v(3, null), v(4, "b"), v(6, "b")]);
    expect(segs.map((s) => [s.subtopicId, s.chunks.map((x) => x.seq)])).toEqual([["a", [0, 1]], ["b", [2]], ["b", [4]], ["b", [6]]]);
  });
  it("splits a long run at the per-kind span limit", () => {
    const segs = groupSegments("video", Array.from({ length: 30 }, (_, i) => v(i, "a")));
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.chunks[s.chunks.length - 1].locator.t_end as number - (s.chunks[0].locator.t_start as number)).toBeLessThanOrEqual(20 * 60);
  });
  it("skips low-information slides", () => {
    const segs = groupSegments("slides", [c(0, "a", { slide: 1 }, true), c(1, "a", { slide: 2 }), c(2, "a", { slide: 3 })]);
    expect(segs).toHaveLength(1);
    expect(segs[0].chunks.map((x) => x.seq)).toEqual([1, 2]);
  });
  it("labels and sizes segments from their locators", () => {
    const chunks = [c(0, "a", { t_start: 860, t_end: 935 }), c(1, "a", { t_start: 935, t_end: 1325 })];
    expect(segmentLabel("video", "Lecture 5", chunks)).toBe("Lecture 5, 14:20–22:05");
    expect(segmentDurationMin("video", chunks)).toBe(8);
    expect(segmentLabel("textbook", "ODS", [c(0, "a", { page: 44 }), c(1, "a", { page: 46 })])).toBe("ODS, pp. 44–46");
  });
});

describe("KB segments as resources → the unchanged v3 planner", () => {
  const app = createApp();
  beforeAll(async () => { await seedFakeKb(); });
  afterAll(async () => {
    await db.update(learningActivities).set({ resourceId: null }).where(like(learningActivities.resourceId, "kb_tst_%"));
    await db.delete(resources).where(like(resources.id, "kb_tst_%"));
    await cleanFakeKb();
    await request(app).post("/api/sim/reset").send({});
  });

  it("upserts one resource per segment, with locator range and a mean embedding, and is idempotent", async () => {
    const first = await buildSegments(VIDEO);
    expect(first.upserted).toBeGreaterThan(0);
    const again = await buildSegments(VIDEO);
    expect(again.upserted).toBe(first.upserted);
    const rows = await db.select().from(resources).where(eq(resources.sourceId, VIDEO));
    expect(rows.length).toBe(first.upserted);
    const seg = rows.find((r) => r.subtopicIds[0] === "ll_singly")!;
    expect(seg.title).toContain("Lecture 5, 14:20");
    expect(seg.url).toContain("youtube.com/watch?v=abcdefghijk&t=860s");
    expect(seg.locatorRange).toMatchObject({ t_start: 860 });
    const emb = await db.execute<{ n: number }>(sql`select vector_dims(embedding) as n from resources where id = ${seg.id}`);
    expect(emb.rows[0].n).toBe(1536);
  });

  it("the unchanged planner stack retrieves, curates and validates KB segments like any resource", async () => {
    await buildSegments(VIDEO);
    await buildSegments(BOOK);
    await db.update(resources).set({ lastVerifiedAt: new Date() }).where(like(resources.id, "kb_tst_%")); // offline: skip live URL checks

    const studentId = await getDemoStudentId();
    await request(app).post("/api/sim/reset").send({});
    const start = await getSimNow(studentId);
    const deadline = new Date(start.getTime() + 55 * 86_400_000).toISOString().slice(0, 10);
    const availability = Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, [{ start: "06:00", end: "23:00" }]]));
    const goal = await request(app).post("/api/goals").send({ student_id: studentId, subject_id: "dsa", deadline, availability, max_daily_min: 480 });
    const keep = ["arr_traversal", "ll_singly", "sq_stack_ops"]; // a prerequisite chain whose root is already mastered
    const all = Object.keys(goal.body.data.blueprint);
    await request(app).post(`/api/goals/${goal.body.data.goal_id}/blueprint`).send({ weights: Object.fromEntries(all.map((id) => [id, keep.includes(id) ? 1 : 0])), dropped: all.filter((id) => !keep.includes(id)) });
    await db.update(studentConstraints).set({ minSessionMin: 5 }).where(eq(studentConstraints.studentId, studentId));
    for (const id of all) {
      const mu = id === "arr_traversal" ? "0.90" : id === "ll_singly" || id === "sq_stack_ops" ? "0.30" : "0.62";
      await db.insert(subtopicMastery).values({ studentId, subtopicId: id, mu, confidence: "0.8", evidenceCount: 8, lastObservedAt: start }).onConflictDoNothing();
    }

    const run = await tick(studentId);
    expect(run.outcome).not.toBe("error");

    // The unchanged v3 retrieval stack finds, ranks and chooses KB segments like any other resource …
    const events = await db.execute<{ message: string; payload: Record<string, unknown> }>(sql`select message, payload from agent_events where run_id = ${run.runId} order by seq`);
    const curator = events.rows.find((e) => e.message.startsWith("Curator") && e.message.includes("kb_tst_"));
    expect(curator, "the Curator should choose a KB segment").toBeTruthy();
    const search = events.rows.filter((e) => (e.payload as { operation?: string })?.operation === "search_learning_resources");
    expect(search.length).toBeGreaterThan(0);

    // … and the v3 validator accepts them: resource fit (C4), the check that reads a resource's duration, passes untouched.
    const report = events.rows.find((e) => e.message.startsWith("Validation:"))!.payload as { checks: Array<{ id: string; status: string }> };
    expect(report.checks.find((c) => c.id === "C4")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "C1")?.status).toBe("pass");
  }, 60000);
});
