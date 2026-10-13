import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../src/app.js";
import { db } from "../../src/db/client.js";
import { learningActivities, studentConstraints, subtopicMastery, tutorSessions, tutorTurns } from "../../src/db/schema.js";
import { advanceSimClock, getSimNow } from "../../src/agent/simClock.js";
import { tick } from "../../src/agent/orchestrator.js";
import { evaluateTriggers, findConfusedSubtopics, type TriggerInput } from "../../src/agent/triggers.js";
import type { Observation } from "../../src/agent/observe.js";
import { getDemoStudentId } from "../tools/helpers.js";

const now = new Date("2026-11-10T08:00:00Z");
const ask = (subtopic: string, hoursAgo: number, confidence = 0.4): Observation => ({
  type: "TUTOR_QUESTION_ASKED", at: new Date(now.getTime() - hoursAgo * 3_600_000), payload: { subtopic_id: subtopic, confidence },
});
const base = (observations: Observation[]): TriggerInput => ({
  now, hasActivePlan: true, observations, missedInLast7d: 0, attendance14d: 1, bufferDays: 10,
  significantPredictionErrors: [], lowScoreSubtopics: [], recallFailures: [], preemptiveRecallSubtopics: [],
  calendarConflicts: [], resourceFailures: [], recoveredTools: [], availabilityDeltaRatio: null, deadlineMoved: false, recentlyFiredAt: {},
});

describe("CONFUSION_SIGNAL (pure)", () => {
  it("fires on ≥2 questions on one subtopic within 48h while confidence < 0.70, scope PATCH", () => {
    const d = evaluateTriggers(base([ask("ll_singly", 30), ask("ll_singly", 2)]));
    expect(d.triggers.map((t) => t.name)).toEqual(["CONFUSION_SIGNAL"]);
    expect(d.scope).toBe("PATCH");
    expect(d.patch_operations).toEqual([{ op: "INSERT_ACTIVITY", params: { action: "IMMEDIATE_TEST", subtopic_id: "ll_singly" } }]);
  });
  it("does not fire for a single question, spread-out questions, different subtopics, or a confident student", () => {
    expect(findConfusedSubtopics([ask("a", 1)], now)).toEqual([]);
    expect(findConfusedSubtopics([ask("a", 60), ask("a", 1)], now)).toEqual([]);
    expect(findConfusedSubtopics([ask("a", 3), ask("b", 1)], now)).toEqual([]);
    expect(findConfusedSubtopics([ask("a", 3, 0.9), ask("a", 1, 0.9)], now)).toEqual([]);
  });
});

describe("CONFUSION_SIGNAL (through the agent loop)", () => {
  afterAll(async () => { await request(createApp()).post("/api/sim/reset").send({}); });

  it("two tutor questions on one subtopic make the next tick insert an IMMEDIATE_TEST nobody asked for", async () => {
    const studentId = await getDemoStudentId();
    const app = createApp();
    await request(app).post("/api/sim/reset").send({});
    const start = await getSimNow(studentId);
    const deadline = new Date(start.getTime() + 55 * 86_400_000).toISOString().slice(0, 10);
    const availability = Object.fromEntries(["1", "2", "3", "4", "5", "6", "0"].map((d) => [d, [{ start: "06:00", end: "23:00" }]]));
    const goal = await request(app).post("/api/goals").send({ student_id: studentId, subject_id: "dsa", deadline, availability, max_daily_min: 480 });
    expect(goal.status).toBe(201);
    // the demo slice: a handful of subtopics is feasible in the window; the whole DSA tree is not
    const keep = ["arr_traversal"];
    const all = Object.keys(goal.body.data.blueprint);
    const bp = await request(app).post(`/api/goals/${goal.body.data.goal_id}/blueprint`).send({ weights: Object.fromEntries(all.map((id) => [id, keep.includes(id) ? 1 : 0])), dropped: all.filter((id) => !keep.includes(id)) });
    expect(bp.status).toBe(200);
    // v3's 10-minute IMMEDIATE_TEST needs a session minimum of ≤10 to satisfy validator rule C6
    await db.update(studentConstraints).set({ minSessionMin: 10 }).where(eq(studentConstraints.studentId, studentId));
    // a student who has taken the onboarding diagnostic: a belief on every subtopic, none of them weak
    for (const id of all) {
      await db.insert(subtopicMastery).values({ studentId, subtopicId: id, mu: "0.62", confidence: "0.80", evidenceCount: 8, lastObservedAt: start }).onConflictDoNothing();
    }
    const first = await tick(studentId); // INITIAL_GOAL builds the plan
    expect(first.outcome).not.toBe("error");

    await advanceSimClock(studentId, 1);
    const simNow = await getSimNow(studentId);
    const subtopicId = "arr_traversal";
    await db.insert(subtopicMastery).values({ studentId, subtopicId, mu: "0.4", confidence: "0.4" }).onConflictDoUpdate({ target: [subtopicMastery.studentId, subtopicMastery.subtopicId], set: { confidence: "0.40" } });
    const [session] = await db.insert(tutorSessions).values({ studentId }).returning({ id: tutorSessions.id });
    for (const minutes of [50, 5]) {
      await db.insert(tutorTurns).values({
        sessionId: session.id, studentId, askedAt: new Date(simNow.getTime() - minutes * 60_000), question: "what is this?",
        subtopicIds: [subtopicId], outcome: "answered", answer: { segments: [] },
      });
    }
    const second = await tick(studentId);
    expect(second.reason).toContain("CONFUSION_SIGNAL");
    expect(second.scope).toBe("PATCH");
    const tests = await db.select().from(learningActivities).where(and(eq(learningActivities.studentId, studentId), eq(learningActivities.subtopicId, subtopicId), eq(learningActivities.action, "IMMEDIATE_TEST")));
    expect(tests.length).toBeGreaterThan(0);

    // consumed: an immediate second tick must not fire it again
    const third = await tick(studentId);
    expect(third.reason).not.toContain("CONFUSION_SIGNAL");
  }, 60000);
});
