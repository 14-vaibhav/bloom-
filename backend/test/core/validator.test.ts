import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validate } from "../../src/core/validator.js";
import type { Activity, ActionType, GapEntry, LearningGoal, StudentConstraintsInput, SubtopicBelief, TopicGraph, ValidatorState } from "../../src/core/types.js";
import { makeBelief } from "./fixtures.js";

function activity(subtopicId: string, action: ActionType, start: string, durationMin: number, overrides: Partial<Activity> = {}): Activity {
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
    ...overrides,
  };
}

function constraints(overrides: Partial<StudentConstraintsInput> = {}): StudentConstraintsInput {
  const window = [{ start: "09:00", end: "21:00" }];
  return {
    weekly_availability: { "0": window, "1": window, "2": window, "3": window, "4": window, "5": window, "6": window },
    max_daily_study_min: 300,
    min_session_min: 15,
    max_session_min: 90,
    blackout_dates: [],
    ...overrides,
  };
}

function goal(overrides: Partial<LearningGoal> = {}): LearningGoal {
  return {
    subject_id: "dsa",
    deadline: new Date("2026-12-31T00:00:00Z"),
    blueprint: { st1: 1.0 },
    target_mastery: { st1: 0.75 },
    must_have_subtopics: [],
    ...overrides,
  };
}

function topicGraph(overrides: Partial<TopicGraph> = {}): TopicGraph {
  return { subtopic_ids: ["st1"], prerequisites: [], base_hours: { st1: 2 }, ...overrides };
}

function gapTable(overrides: GapEntry[] = []): GapEntry[] {
  if (overrides.length > 0) return overrides;
  return [
    {
      subtopic_id: "st1",
      priority: 90,
      action: "PRACTICE",
      gap_snapshot: { gap: 0.45, severity: 0.45, blocking_term: 0, urgency: 0.5, learnability: 0.5, uncertainty: 0.1, retention_risk: 0 },
    },
  ];
}

function state(overrides: Partial<ValidatorState> = {}): ValidatorState {
  return {
    beliefs: [makeBelief({ subtopic_id: "st1", mu: 0.3 })],
    topicGraph: topicGraph(),
    goal: goal(),
    gapTable: gapTable(),
    externalEvents: [],
    resourceDurations: {},
    completedActiveRecallCounts: {},
    ...overrides,
  };
}

/** Baseline: one PRACTICE + one FINAL_TEST for st1, on separate days, well inside every
 * constraint. Passes all 12 checks — see the file header on why that's worth asserting. */
function validPlan() {
  const activities = [
    activity("st1", "PRACTICE", "2026-11-02T10:00:00Z", 30),
    activity("st1", "FINAL_TEST", "2026-11-03T10:00:00Z", 20),
  ];
  return { activities, projection: { projected_mastery_at_deadline: { st1: 0.7 }, projected_goal_attainment: 0.9, deficit_hours: 0, unplaced_hours: {} } };
}

function checkStatus(report: ReturnType<typeof validate>, id: string) {
  return report.checks.find((c) => c.id === id)?.status;
}

describe("validator — bloom-phase5-brief §5", () => {
  it("a fully valid plan: all 12 checks present, all pass, route = commit", () => {
    const report = validate(validPlan(), state(), constraints());
    expect(report.checks).toHaveLength(12);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
    expect(report.valid).toBe(true);
    expect(report.route).toBe("commit");
  });

  it("C1: two overlapping activities (18:00-19:00, 18:30-19:30) fail", () => {
    const plan = {
      activities: [activity("st1", "PRACTICE", "2026-11-02T18:00:00Z", 60), activity("st1", "PRACTICE", "2026-11-02T18:30:00Z", 60)],
      projection: validPlan().projection,
    };
    const report = validate(plan, state({ beliefs: [makeBelief({ subtopic_id: "st1", mu: 0.3 })] }), constraints());
    expect(checkStatus(report, "C1")).toBe("fail");
  });

  it("C1: touching endpoints (18:00-19:00, 19:00-20:00) pass — half-open intervals", () => {
    const plan = {
      activities: [activity("st1", "PRACTICE", "2026-11-02T18:00:00Z", 60), activity("st1", "PRACTICE", "2026-11-02T19:00:00Z", 60)],
      projection: validPlan().projection,
    };
    const report = validate(plan, state(), constraints());
    expect(checkStatus(report, "C1")).toBe("pass");
  });

  it("C2: 150 minutes scheduled on a 120-minute cap day fails, with the date in the detail", () => {
    const plan = {
      activities: [activity("st1", "PRACTICE", "2026-11-06T10:00:00Z", 90), activity("st1", "PRACTICE", "2026-11-06T12:00:00Z", 60)],
      projection: validPlan().projection,
    };
    const report = validate(plan, state(), constraints({ max_daily_study_min: 120, max_session_min: 90 }));
    const c2 = report.checks.find((c) => c.id === "C2")!;
    expect(c2.status).toBe("fail");
    expect(c2.detail).toContain("2026-11-06");
  });

  it("C3: an activity ending after the deadline fails", () => {
    const plan = { activities: [activity("st1", "PRACTICE", "2026-12-31T23:00:00Z", 90)], projection: validPlan().projection };
    const report = validate(plan, state(), constraints());
    expect(checkStatus(report, "C3")).toBe("fail");
  });

  it("C4: a 60-minute resource in a 45-minute slot fails", () => {
    const plan = { activities: [activity("st1", "PRACTICE", "2026-11-02T10:00:00Z", 45, { resource_id: "res_1" })], projection: validPlan().projection };
    const report = validate(plan, state({ resourceDurations: { res_1: 60 } }), constraints());
    expect(checkStatus(report, "C4")).toBe("fail");
  });

  it("C5: a dependent subtopic scheduled before its unmastered prerequisite fails", () => {
    const plan = {
      activities: [activity("arrays", "LEARN", "2026-11-05T10:00:00Z", 30), activity("graphs", "LEARN", "2026-11-02T10:00:00Z", 30)],
      projection: validPlan().projection,
    };
    const s = state({
      beliefs: [makeBelief({ subtopic_id: "arrays", mu: 0.1 }), makeBelief({ subtopic_id: "graphs", mu: 0.1 })],
      topicGraph: topicGraph({ subtopic_ids: ["arrays", "graphs"], prerequisites: [{ subtopic_id: "graphs", prereq_id: "arrays" }] }),
      goal: goal({ blueprint: { arrays: 0.5, graphs: 0.5 }, target_mastery: { arrays: 0.75, graphs: 0.75 } }),
    });
    const report = validate(plan, s, constraints());
    expect(checkStatus(report, "C5")).toBe("fail");
  });

  it("C6: an activity on a blackout date fails", () => {
    const plan = { activities: [activity("st1", "PRACTICE", "2026-11-02T10:00:00Z", 30)], projection: validPlan().projection };
    const report = validate(plan, state(), constraints({ blackout_dates: ["2026-11-02"] }));
    expect(checkStatus(report, "C6")).toBe("fail");
  });

  it("C7: a subtopic with LEARN but no FINAL_TEST fails", () => {
    const plan = { activities: [activity("st1", "LEARN", "2026-11-02T10:00:00Z", 30)], projection: validPlan().projection };
    const report = validate(plan, state(), constraints());
    expect(checkStatus(report, "C7")).toBe("fail");
  });

  it("L2: a completed subtopic with only 1 recall fails", () => {
    const plan = {
      activities: [activity("st1", "ACTIVE_RECALL", "2026-11-02T10:00:00Z", 15), activity("st1", "FINAL_TEST", "2026-11-03T10:00:00Z", 20)],
      projection: validPlan().projection,
    };
    const s = state({ beliefs: [makeBelief({ subtopic_id: "st1", mu: 0.8 })] }); // mu >= target 0.75 -> "completed"
    const report = validate(plan, s, constraints());
    expect(checkStatus(report, "L2")).toBe("fail");
  });

  it("L5: projected attainment below target for a must-have subtopic routes to negotiate, not repair", () => {
    const plan = { ...validPlan(), projection: { ...validPlan().projection, projected_mastery_at_deadline: { st1: 0.62 } } };
    const s = state({ goal: goal({ must_have_subtopics: ["st1"], target_mastery: { st1: 0.75 } }) });
    const report = validate(plan, s, constraints());
    expect(checkStatus(report, "L5")).toBe("fail");
    expect(report.route).toBe("negotiate");
  });

  it("L5 failing alongside a repairable hard failure still routes to negotiate", () => {
    const plan = {
      activities: [activity("st1", "PRACTICE", "2026-11-02T18:00:00Z", 60), activity("st1", "PRACTICE", "2026-11-02T18:30:00Z", 60)],
      projection: { ...validPlan().projection, projected_mastery_at_deadline: { st1: 0.1 } },
    };
    const s = state({ goal: goal({ must_have_subtopics: ["st1"], target_mastery: { st1: 0.75 } }) });
    const report = validate(plan, s, constraints());
    expect(checkStatus(report, "C1")).toBe("fail");
    expect(checkStatus(report, "L5")).toBe("fail");
    expect(report.route).toBe("negotiate");
  });

  it("L4 is soft: a warn never flips `valid` to false or blocks commit", () => {
    const plan = { activities: [activity("st1", "LEARN", "2026-11-02T10:00:00Z", 80), activity("st1", "FINAL_TEST", "2026-11-03T10:00:00Z", 20)], projection: validPlan().projection };
    // 80 LEARN + 20 FINAL_TEST -> only 20% of minutes are practice/assessment, below the 30%
    // floor -> L4 warns. mu=0.6 sits between the L3 (<0.5) and L2 "completed" (>=target 0.75)
    // thresholds, so neither of those hard checks fires and L4 is the only thing that warns.
    const s = state({ beliefs: [makeBelief({ subtopic_id: "st1", mu: 0.6 })] });
    const report = validate(plan, s, constraints());
    const l4 = report.checks.find((c) => c.id === "L4")!;
    expect(l4.status).toBe("warn");
    expect(report.valid).toBe(true);
    expect(report.route).toBe("commit");
  });

  it("★ the validator shares no imports with the planner or the slotter", () => {
    const source = readFileSync(new URL("../../src/core/validator.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']\.\/planner\.js["']/);
    expect(source).not.toMatch(/from ["']\.\/slotter\.js["']/);
  });
});
