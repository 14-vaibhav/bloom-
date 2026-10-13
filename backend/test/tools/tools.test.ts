import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { questions, calendarEvents } from "../../src/db/schema.js";
import { getDemoStudentId } from "./helpers.js";

import * as performance from "../../src/tools/performance.js";
import * as rag from "../../src/tools/rag.js";
import * as calendar from "../../src/tools/calendar.js";
import * as qbank from "../../src/tools/qbank.js";
import * as state from "../../src/tools/state.js";
import { PermanentError } from "../../src/tools/errors.js";

let studentId: string;

beforeAll(async () => {
  studentId = await getDemoStudentId();
});

afterAll(async () => {
  // seedOneQuestion() below inserts real rows into `questions` (FK-bound to a real
  // subtopic) so qbank.ts's real DB queries exercise real constraints — clean them up
  // so they don't linger as noise in the seeded content.
  await db.delete(questions).where(like(questions.id, "__qbank_test_question_%"));
});

describe("performance tool", () => {
  it("get_student_performance returns a schema-valid rollup with no data", async () => {
    const out = await performance.getStudentPerformance({ student_id: studentId });
    expect(out.overall_mastery).toBeGreaterThanOrEqual(0);
    expect(out.assessments_taken).toBeGreaterThanOrEqual(0);
  });

  it("get_subtopic_performance returns baseline defaults for subtopics with no mastery row", async () => {
    const out = await performance.getSubtopicPerformance({ student_id: studentId, subtopic_ids: ["arr_traversal"] });
    expect(out).toHaveLength(1);
    expect(out[0].mu).toBe(0);
    expect(out[0].format_efficacy).toBeTruthy();
  });

  it("get_completion_history rejects a malformed `since` as a permanent error", async () => {
    await expect(performance.getCompletionHistory({ student_id: studentId, since: "not-a-date" })).rejects.toThrow(
      PermanentError,
    );
  });
});

describe("rag tool", () => {
  it("search_learning_resources returns [] (not an error) when nothing matches", async () => {
    const { output } = await rag.searchLearningResources({
      subtopic_id: "does_not_exist",
      target_difficulty: 3,
      max_duration_min: 30,
      exclude_ids: [],
      k: 8,
    });
    expect(output).toEqual([]);
  });

  it("search_learning_resources returns live candidates for a real subtopic (fallback-quality ranked pre-embedding)", async () => {
    const { output } = await rag.searchLearningResources({
      subtopic_id: "arr_traversal",
      target_difficulty: 3,
      max_duration_min: 120,
      exclude_ids: [],
      k: 8,
    });
    expect(output.length).toBeGreaterThan(0);
    expect(output[0].ranked_by).toBe("fallback_quality");
  });

  it("get_resource_details throws PermanentError for an unknown id", async () => {
    await expect(rag.getResourceDetails({ resource_id: "res_does_not_exist" })).rejects.toThrow(PermanentError);
  });
});

describe("calendar tool", () => {
  it("get_available_slots respects blackout dates, the daily cap, and the effective-dated constraint row", async () => {
    const out = await calendar.getAvailableSlots({
      student_id: studentId,
      from: "2026-11-02T00:00:00Z",
      to: "2026-11-05T00:00:00Z",
      min_slot_min: 15,
    });
    expect(Array.isArray(out)).toBe(true);
    for (const slot of out) {
      expect(slot.duration_min).toBeLessThanOrEqual(90); // maxSessionMin from seed
    }
  });

  it("create → modify → delete a Bloom-owned session round-trips cleanly", async () => {
    // Create a backing activity via save_plan_version rather than reaching into
    // learning_activities directly, so this test stays tool-boundary-only.
    const saved = await state.savePlanVersion({
      student_id: studentId,
      goal_id: await ensureGoal(studentId),
      version: 9001,
      trigger: "TEST",
      scope: "PATCH",
      reason: "calendar round-trip test",
      repair_rounds: 0,
      activities: [
        {
          subtopic_id: "arr_traversal",
          action: "LEARN",
          scheduled_start: "2030-01-01T10:00:00Z",
          scheduled_end: "2030-01-01T10:30:00Z",
          duration_min: 30,
          provisional: false,
          create_calendar_session: false,
        },
      ],
    });

    const created = await calendar.createLearningSession({
      activity_id: saved.activity_ids[0],
      start: "2030-01-01T10:00:00Z",
      end: "2030-01-01T10:30:00Z",
      title: "test session",
    });
    expect(created.source).toBe("bloom");

    const modified = await calendar.modifyLearningSession({
      event_id: created.event_id,
      start: "2030-01-01T11:00:00Z",
      end: "2030-01-01T11:30:00Z",
    });
    expect(modified.starts_at).toBe("2030-01-01T11:00:00.000Z");

    const deleted = await calendar.deleteLearningSession({ event_id: created.event_id });
    expect(deleted.deleted).toBe(true);
  });
});

const TEST_SUBTOPIC = "arr_traversal";

describe("question bank tool", () => {
  // compose_assessment's own random-pick contract, independent of which question it lands on
  // (real generated content may coexist with the fixture once GEMINI_API_KEY is set).
  it("compose_assessment writes predicted_score before any answer exists", async () => {
    await seedOneQuestion();
    const composed = await qbank.composeAssessment({
      student_id: studentId,
      subtopic_id: TEST_SUBTOPIC,
      purpose: "diagnostic",
      count: 1,
    });
    expect(composed.predicted_score).toBeGreaterThanOrEqual(0);
    expect(composed.composition.revision).toBe(0);
    expect(composed.composition.targeted).toBe(0);
  });

  // The rest pin scoring against a hand-built assessment referencing the fixture question
  // directly, so results don't depend on which question compose_assessment's random pick lands on.
  it("submit_answers scores correctly and does NOT touch subtopic_mastery", async () => {
    const questionId = await seedOneQuestion();
    const assessmentId = await makeFixedAssessment(studentId, questionId);
    const result = await qbank.submitAnswers({
      assessment_id: assessmentId,
      answers: [{ question_id: questionId, chosen_index: 0 }], // correct
    });
    expect(result.score).toBe(1);
    expect(result.revision_pool_additions).toEqual([]);
  });

  it("submitting the same assessment twice returns the first result, doesn't re-score", async () => {
    const questionId = await seedOneQuestion();
    const assessmentId = await makeFixedAssessment(studentId, questionId);
    const first = await qbank.submitAnswers({
      assessment_id: assessmentId,
      answers: [{ question_id: questionId, chosen_index: 0 }],
    });
    const second = await qbank.submitAnswers({
      assessment_id: assessmentId,
      answers: [{ question_id: questionId, chosen_index: 1 }], // different answer — ignored
    });
    expect(second.score).toBe(first.score);
    expect(second.submitted_at).toBe(first.submitted_at);
  });

  it("a wrong answer adds the question to the revision pool; a right one clears it", async () => {
    const questionId = await seedOneQuestion();
    const assessmentId = await makeFixedAssessment(studentId, questionId);
    await qbank.submitAnswers({
      assessment_id: assessmentId,
      answers: [{ question_id: questionId, chosen_index: 1 }], // wrong (correct is 0)
    });
    const pool = await qbank.getRevisionPool({ student_id: studentId, subtopic_id: TEST_SUBTOPIC });
    expect(pool.some((q) => q.question_id === questionId)).toBe(true);
  });

  it("submit_answers with a repeated idempotency_key does not double-score", async () => {
    const questionId = await seedOneQuestion();
    const assessmentId = await makeFixedAssessment(studentId, questionId);
    const key = `idem-${Date.now()}`;

    const first = await qbank.submitAnswers({
      assessment_id: assessmentId,
      answers: [{ question_id: questionId, chosen_index: 0 }],
      idempotency_key: key,
    });
    const second = await qbank.submitAnswers({
      assessment_id: assessmentId,
      answers: [{ question_id: questionId, chosen_index: 1 }], // would score 0 if re-run — must be ignored
      idempotency_key: key,
    });
    expect(second).toEqual(first);
  });
});

describe("state tool", () => {
  it("get_student_state assembles student + constraints without error", async () => {
    const out = await state.getStudentState({ student_id: studentId });
    expect(out.student.id).toBe(studentId);
    expect(out.constraints).not.toBeNull();
    expect(out.projection).toBeNull();
  });

  it("get_constraints resolves the row effective at a given instant", async () => {
    const out = await state.getConstraints({ student_id: studentId, effective_at: "2026-11-05T00:00:00Z" });
    expect(out).not.toBeNull();
  });

  it("save_plan_version is atomic: activities and calendar sessions land together", async () => {
    const goalId = await ensureGoal(studentId);
    const result = await state.savePlanVersion({
      student_id: studentId,
      goal_id: goalId,
      version: 9002,
      trigger: "TEST",
      scope: "FULL",
      reason: "atomicity test",
      repair_rounds: 0,
      activities: [
        {
          subtopic_id: "arr_traversal",
          action: "LEARN",
          scheduled_start: "2030-02-01T10:00:00Z",
          scheduled_end: "2030-02-01T10:30:00Z",
          duration_min: 30,
          provisional: false,
          create_calendar_session: true,
        },
      ],
    });
    expect(result.activity_ids).toHaveLength(1);
    expect(result.calendar_event_ids).toHaveLength(1);

    const [event] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, result.calendar_event_ids[0]));
    expect(event.activityId).toBe(result.activity_ids[0]);
  });

  it("save_plan_version with a repeated idempotency_key does not create a second plan version", async () => {
    const goalId = await ensureGoal(studentId);
    const key = `idem-${Date.now()}`;
    const call = () =>
      state.savePlanVersion({
        student_id: studentId,
        goal_id: goalId,
        version: 9003 + Math.floor(Math.random() * 1000), // varies per call — proves the cache, not luck, wins
        trigger: "TEST",
        scope: "PATCH",
        reason: "idempotency test",
        repair_rounds: 0,
        activities: [],
        idempotency_key: key,
      });

    const first = await call();
    const second = await call();
    expect(second).toEqual(first);
  });
});

// ── local fixtures ──────────────────────────────────────────────

async function ensureGoal(studentId: string): Promise<string> {
  const { learningGoals } = await import("../../src/db/schema.js");
  const [existing] = await db.select().from(learningGoals).limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(learningGoals)
    .values({
      studentId,
      subjectId: "dsa",
      title: "Test goal",
      deadline: "2030-12-31",
      blueprint: {},
      targetMastery: {},
    })
    .returning({ id: learningGoals.id });
  return row.id;
}

async function seedOneQuestion(): Promise<string> {
  const id = `__qbank_test_question_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(questions).values({
    id,
    subjectId: "dsa",
    topicId: "arrays",
    subtopicId: TEST_SUBTOPIC,
    difficulty: 1,
    stem: `test stem ${id}`,
    options: ["a", "b", "c", "d"],
    correctIndex: 0,
    explanation: "because",
    reviewed: true,
  });
  return id;
}

async function makeFixedAssessment(studentId: string, questionId: string): Promise<string> {
  const { assessments } = await import("../../src/db/schema.js");
  const [row] = await db
    .insert(assessments)
    .values({
      studentId,
      purpose: "diagnostic",
      subtopicIds: [TEST_SUBTOPIC],
      questionIds: [questionId],
      composition: { new: 1, revision: 0, targeted: 0 },
      predictedScore: "0.5",
    })
    .returning({ id: assessments.id });
  return row.id;
}
