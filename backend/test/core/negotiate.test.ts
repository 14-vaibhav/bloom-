import { describe, it, expect } from "vitest";
import { negotiate } from "../../src/core/negotiate.js";
import { validate } from "../../src/core/validator.js";
import type { Activity, ActionType, DropCandidate, LearningGoal, NegotiateInput, Plan, StudentConstraintsInput, TopicGraph, ValidatorState } from "../../src/core/types.js";
import { makeBelief } from "./fixtures.js";

function activity(subtopicId: string, action: ActionType, start: string, durationMin: number): Activity {
  const startDate = new Date(start);
  return {
    subtopic_id: subtopicId,
    resource_id: null,
    action,
    start: startDate,
    end: new Date(startDate.getTime() + durationMin * 60_000),
    duration_min: durationMin,
    priority: 50,
    predicted_score: 0.5,
    expected_mastery_after: 0.5,
    provisional: false,
  };
}

function planOf(activities: Activity[], projection: Partial<Plan["projection"]> = {}): Plan {
  return {
    activities,
    projection: { projected_mastery_at_deadline: {}, projected_goal_attainment: 0.9, deficit_hours: 0, unplaced_hours: {}, ...projection },
    degraded_tools: [],
  };
}

function baseInput(overrides: Partial<NegotiateInput> = {}): NegotiateInput {
  const plan = planOf([
    activity("core_a", "LEARN", "2026-11-02T10:00:00Z", 60),
    activity("core_a", "FINAL_TEST", "2026-11-03T10:00:00Z", 20),
    activity("drop_a", "LEARN", "2026-11-04T10:00:00Z", 60),
  ]);
  return {
    required_hours: 24,
    available_hours: 18,
    days_remaining: 12,
    must_have_subtopics: ["core_a"],
    drop_candidates: [{ subtopic_id: "drop_a", weight: 0.11, hours_needed: 6 }],
    plan,
    ...overrides,
  };
}

describe("negotiate — bloom-phase5-brief §7", () => {
  it("★ the corrected §7.3 worked example: costs 0.571 / 0.333 / 1.100, recommends B", () => {
    const result = negotiate(baseInput());
    expect(result.deficit_hours).toBeCloseTo(6, 5);
    const [a, b, c] = result.options;
    expect(a.cost).toBeCloseTo(0.571, 2);
    expect(b.cost).toBeCloseTo(0.333, 2);
    expect(c.cost).toBeCloseTo(1.1, 2);
    expect(result.recommended).toBe("B");
  });

  it("best_partial_plan drops the deferred subtopics but keeps everything else", () => {
    const result = negotiate(baseInput());
    expect(result.deferred_subtopics).toContain("drop_a");
    expect(result.best_partial_plan.activities.some((a) => a.subtopic_id === "drop_a")).toBe(false);
    expect(result.best_partial_plan.activities.some((a) => a.subtopic_id === "core_a")).toBe(true);
  });

  it("best_partial_plan still passes C1-C6", () => {
    const result = negotiate(baseInput());
    const topicGraph: TopicGraph = { subtopic_ids: ["core_a", "drop_a"], prerequisites: [], base_hours: { core_a: 2, drop_a: 2 } };
    const goal: LearningGoal = {
      subject_id: "dsa",
      deadline: new Date("2026-12-31T00:00:00Z"),
      blueprint: { core_a: 0.6, drop_a: 0.4 },
      target_mastery: { core_a: 0.75, drop_a: 0.75 },
      must_have_subtopics: ["core_a"],
    };
    const state: ValidatorState = {
      beliefs: [makeBelief({ subtopic_id: "core_a", mu: 0.6 }), makeBelief({ subtopic_id: "drop_a", mu: 0.6 })],
      topicGraph,
      goal,
      gapTable: [],
      externalEvents: [],
      resourceDurations: {},
      completedActiveRecallCounts: {},
    };
    const constraints: StudentConstraintsInput = {
      weekly_availability: { "0": [{ start: "00:00", end: "23:59" }], "1": [{ start: "00:00", end: "23:59" }], "2": [{ start: "00:00", end: "23:59" }], "3": [{ start: "00:00", end: "23:59" }], "4": [{ start: "00:00", end: "23:59" }], "5": [{ start: "00:00", end: "23:59" }], "6": [{ start: "00:00", end: "23:59" }] },
      max_daily_study_min: 300,
      min_session_min: 5,
      max_session_min: 200,
      blackout_dates: [],
    };
    const report = validate(result.best_partial_plan, state, constraints);
    for (const id of ["C1", "C2", "C3", "C4", "C5", "C6"] as const) {
      expect(report.checks.find((c) => c.id === id)!.status).not.toBe("fail");
    }
  });

  it("must-have subtopics never appear in deferred_subtopics, even if the caller passes one", () => {
    const dropCandidates: DropCandidate[] = [
      { subtopic_id: "core_a", weight: 0.5, hours_needed: 100 }, // must-have, should be filtered out
      { subtopic_id: "drop_a", weight: 0.11, hours_needed: 6 },
    ];
    const result = negotiate(baseInput({ drop_candidates: dropCandidates }));
    expect(result.deferred_subtopics).not.toContain("core_a");
  });

  it("zero or negative deficit throws — the caller should never invoke this then", () => {
    expect(() => negotiate(baseInput({ required_hours: 10, available_hours: 18 }))).toThrow();
    expect(() => negotiate(baseInput({ required_hours: 18, available_hours: 18 }))).toThrow();
  });

  it("option C reports infinite cost and an explanatory description when nothing can be dropped", () => {
    const result = negotiate(baseInput({ drop_candidates: [] }));
    const c = result.options.find((o) => o.label === "C")!;
    expect(c.cost).toBe(Number.POSITIVE_INFINITY);
    expect(result.deferred_subtopics).toEqual([]);
    expect(result.recommended).not.toBe("C");
  });
});
