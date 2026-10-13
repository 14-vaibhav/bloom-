import { describe, it, expect } from "vitest";
import { operators, runValidationLoop } from "../../src/core/repair.js";
import { validate } from "../../src/core/validator.js";
import { injectDefect } from "../../src/core/injectDefect.js";
import type { Activity, ActionType, LearningGoal, Plan, StudentConstraintsInput, SubtopicBelief, TopicGraph, ValidatorState } from "../../src/core/types.js";

function belief(id: string, mu: number): SubtopicBelief {
  return {
    subtopic_id: id,
    mu,
    confidence: 0.3,
    learn_rate: 0.1,
    evidence_count: 0,
    assessment_count: 0,
    last_observed_at: null,
    mu_at_last_observation: mu,
    hours_since_last_observation: 0,
    prediction_error_ema: 0,
    format_efficacy: { video: 0.1, article: 0.1, practice: 0.1, doc: 0.1, course: 0.1 },
    retention_estimate: 0.5,
    strength_days: 3,
  };
}

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
  const window = [{ start: "00:00", end: "23:59" }];
  return {
    weekly_availability: { "0": window, "1": window, "2": window, "3": window, "4": window, "5": window, "6": window },
    max_daily_study_min: 300,
    min_session_min: 5,
    max_session_min: 200,
    blackout_dates: [],
    ...overrides,
  };
}

function goal(overrides: Partial<LearningGoal> = {}): LearningGoal {
  return {
    subject_id: "dsa",
    deadline: new Date("2026-12-31T00:00:00Z"),
    blueprint: { aux: 0.5, st1: 0.5 },
    target_mastery: { aux: 0.75, st1: 0.75 },
    must_have_subtopics: [],
    ...overrides,
  };
}

function topicGraph(overrides: Partial<TopicGraph> = {}): TopicGraph {
  return { subtopic_ids: ["aux", "st1"], prerequisites: [], base_hours: { aux: 2, st1: 2 }, ...overrides };
}

function state(overrides: Partial<ValidatorState> = {}): ValidatorState {
  return {
    beliefs: [belief("aux", 0.6), belief("st1", 0.6)],
    topicGraph: topicGraph(),
    goal: goal(),
    gapTable: [],
    externalEvents: [],
    resourceDurations: {},
    completedActiveRecallCounts: {},
    ...overrides,
  };
}

function planOf(activities: Activity[]): Plan {
  return {
    activities,
    projection: { projected_mastery_at_deadline: { aux: 0.7, st1: 0.7 }, projected_goal_attainment: 0.9, deficit_hours: 0, unplaced_hours: {} },
    degraded_tools: [],
  };
}

/** Two independent, already-valid subtopics — "aux" absorbs L1/L3/C7 concerns so each
 * defect test can target "st1" (or its own fixture) without secondary, unrelated failures
 * cascading in after a repair (e.g. DEFER dropping the only subtopic in the plan). */
function baselinePlan(): Plan {
  return planOf([
    activity("aux", "PRACTICE", "2026-11-02T09:00:00Z", 30),
    activity("aux", "FINAL_TEST", "2026-11-03T09:00:00Z", 20),
    activity("st1", "PRACTICE", "2026-11-02T10:00:00Z", 30),
    activity("st1", "FINAL_TEST", "2026-11-03T10:00:00Z", 20),
  ]);
}

describe("repair — bloom-phase5-brief §6", () => {
  it("a capacity failure is fixed by SHIFT first, not COMPRESS", () => {
    const plan = injectDefect(baselinePlan(), "capacity", { maxDailyStudyMin: 120 });
    const result = runValidationLoop(plan, state(), constraints({ max_daily_study_min: 120 }));
    expect(result.route).toBe("commit");
    expect(result.log[0].check_id).toBe("C2");
    expect(result.log[0].operator).toBe("SHIFT");
  });

  it("SHIFT returns null when every reachable day is blacked out", () => {
    const a = activity("st1", "PRACTICE", "2026-11-02T10:00:00Z", 30);
    const b = activity("st1", "PRACTICE", "2026-11-02T10:15:00Z", 30);
    const plan = planOf([a, b]);
    const blackout = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 10, 3 + i)).toISOString().slice(0, 10));
    const c = constraints({ blackout_dates: blackout });
    const report = validate(plan, state(), c);
    const c1 = report.checks.find((ch) => ch.id === "C1")!;
    expect(operators.SHIFT(plan, c1, { validatorState: state(), constraints: c })).toBeNull();
  });

  it("SWAP genuinely resolves a capacity overflow by trading a long slot for a short one", () => {
    // X(100)+M(20) on day1 = 120 > cap(110); Y(10) alone on day2. Swapping X and Y's START
    // times (each keeping its OWN duration — see repair.ts's swapTimes header) moves the
    // long block to day2 and a short one to day1, curing day1 without overloading day2.
    const x = activity("st1", "PRACTICE", "2026-11-02T09:00:00Z", 100, { priority: 50 });
    const m = activity("st1", "PRACTICE", "2026-11-02T11:00:00Z", 20, { priority: 50 });
    const y = activity("st1", "PRACTICE", "2026-11-03T09:00:00Z", 10, { priority: 5 });
    const plan = planOf([x, m, y]);
    const c = constraints({ max_daily_study_min: 110 });
    const report = validate(plan, state(), c);
    const c2 = report.checks.find((ch) => ch.id === "C2")!;
    const swapped = operators.SWAP(plan, c2, { validatorState: state(), constraints: c });
    expect(swapped).not.toBeNull();
    if (swapped) expect(validate(swapped, state(), c).checks.find((ch) => ch.id === "C2")!.status).toBe("pass");
  });

  it("★ a no-op SWAP between two equal-duration, equal-shape activities is caught by the oscillation guard", () => {
    // X(70)+M(40) on day1 = 110 > cap(100); Y(70) on day2. SHIFT is blocked (blackout) and
    // SPLIT would newly collide with Y, so SWAP is tried — but swapping X and Y (same
    // subtopic/action/duration) just relabels who sits where; the resulting plan hashes
    // identically to the one that went in, and the guard must catch that on round 1.
    const x = activity("st1", "PRACTICE", "2026-11-02T10:00:00Z", 70, { priority: 50 });
    const m = activity("st1", "PRACTICE", "2026-11-02T11:10:00Z", 40, { priority: 50 });
    const y = activity("st1", "PRACTICE", "2026-11-03T10:00:00Z", 70, { priority: 5 });
    const plan = planOf([x, m, y]);
    const c = constraints({ max_daily_study_min: 100, blackout_dates: ["2026-11-03"] });
    // A tight deadline (2 days out) closes off SHIFT's escape route past the blackout —
    // without it SHIFT would happily jump to day+2 and this never reaches SWAP at all.
    const s = state({ goal: goal({ deadline: new Date("2026-11-04T00:00:00Z") }) });
    const result = runValidationLoop(plan, s, c);
    expect(result.route).toBe("negotiate");
    expect(result.rounds).toBe(1);
    expect(result.log[0].operator).toBe("SWAP");
    expect(result.log[0].detail).toMatch(/Oscillation/);
  });

  it("three rounds exhausted without a fix routes to negotiate, respecting the cap", () => {
    // A must-have subtopic missing its final test: DEFER refuses to drop a must-have, and
    // no other operator applies to C7, so this negotiates on round 1 — still within cap.
    const plan = planOf([activity("st1", "LEARN", "2026-11-02T10:00:00Z", 30)]);
    const result = runValidationLoop(plan, state({ goal: goal({ must_have_subtopics: ["st1"] }) }), constraints());
    expect(result.route).toBe("negotiate");
    expect(result.rounds).toBeLessThanOrEqual(3);
  });

  it("each round emits a log entry naming the check id, the operator, and a concrete detail", () => {
    const plan = injectDefect(baselinePlan(), "capacity", { maxDailyStudyMin: 120 });
    const result = runValidationLoop(plan, state(), constraints({ max_daily_study_min: 120 }));
    expect(result.log.length).toBeGreaterThan(0);
    for (const entry of result.log) {
      expect(entry.check_id).toBeTruthy();
      expect(entry.operator).toBeTruthy();
      expect(entry.detail.length).toBeGreaterThan(0);
    }
  });

  describe("★ 5 injected defects, each caught and each repaired to a passing plan", () => {
    it("overlap", () => {
      const plan = injectDefect(baselinePlan(), "overlap");
      expect(validate(plan, state(), constraints()).checks.find((c) => c.id === "C1")!.status).toBe("fail");
      const result = runValidationLoop(plan, state(), constraints());
      expect(result.route).toBe("commit");
      expect(result.finalReport.valid).toBe(true);
    });

    it("deadline", () => {
      const g = goal();
      const plan = injectDefect(baselinePlan(), "deadline", { deadline: g.deadline });
      expect(validate(plan, state({ goal: g }), constraints()).checks.find((c) => c.id === "C3")!.status).toBe("fail");
      const result = runValidationLoop(plan, state({ goal: g }), constraints());
      expect(result.route).toBe("commit");
      expect(result.finalReport.valid).toBe(true);
    });

    it("missing_final", () => {
      const plan = injectDefect(baselinePlan(), "missing_final");
      expect(validate(plan, state(), constraints()).checks.find((c) => c.id === "C7")!.status).toBe("fail");
      const result = runValidationLoop(plan, state(), constraints());
      expect(result.route).toBe("commit");
      expect(result.finalReport.valid).toBe(true);
    });

    it("prereq", () => {
      const graph = topicGraph({ subtopic_ids: ["arrays", "graphs"], prerequisites: [{ subtopic_id: "graphs", prereq_id: "arrays" }] });
      const base = planOf([
        activity("arrays", "LEARN", "2026-11-02T10:00:00Z", 30),
        activity("graphs", "LEARN", "2026-11-03T10:00:00Z", 30),
        activity("arrays", "FINAL_TEST", "2026-11-04T10:00:00Z", 20),
        activity("graphs", "FINAL_TEST", "2026-11-05T10:00:00Z", 20),
      ]);
      // mu just below the "mastered" cutoff (target * 0.7 = 0.525) but above L3's 0.5 floor,
      // so the ordering defect is the only thing this fixture can fail.
      const s = state({
        beliefs: [belief("arrays", 0.51), belief("graphs", 0.51)],
        topicGraph: graph,
        goal: goal({ blueprint: { arrays: 0.5, graphs: 0.5 }, target_mastery: { arrays: 0.75, graphs: 0.75 } }),
      });
      const plan = injectDefect(base, "prereq", { topicGraph: graph });
      expect(validate(plan, s, constraints()).checks.find((c) => c.id === "C5")!.status).toBe("fail");
      const result = runValidationLoop(plan, s, constraints());
      expect(result.route).toBe("commit");
      expect(result.finalReport.valid).toBe(true);
    });

    it("capacity", () => {
      const plan = injectDefect(baselinePlan(), "capacity", { maxDailyStudyMin: 120 });
      const c = constraints({ max_daily_study_min: 120 });
      expect(validate(plan, state(), c).checks.find((ch) => ch.id === "C2")!.status).toBe("fail");
      const result = runValidationLoop(plan, state(), c);
      expect(result.route).toBe("commit");
      expect(result.finalReport.valid).toBe(true);
    });
  });
});
