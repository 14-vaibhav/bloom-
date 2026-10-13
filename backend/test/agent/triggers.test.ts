import { describe, expect, it } from "vitest";
import { evaluateTriggers, type TriggerInput } from "../../src/agent/triggers.js";

function baseInput(overrides: Partial<TriggerInput> = {}): TriggerInput {
  return {
    now: new Date("2026-11-10T08:00:00Z"),
    hasActivePlan: true,
    observations: [],
    missedInLast7d: 0,
    attendance14d: 0.9,
    bufferDays: 5,
    significantPredictionErrors: [],
    lowScoreSubtopics: [],
    recallFailures: [],
    preemptiveRecallSubtopics: [],
    calendarConflicts: [],
    resourceFailures: [],
    recoveredTools: [],
    availabilityDeltaRatio: null,
    deadlineMoved: false,
    recentlyFiredAt: {},
    ...overrides,
  };
}

describe("evaluateTriggers", () => {
  it("returns NONE with a real reason when nothing crosses a threshold", () => {
    const decision = evaluateTriggers(baseInput());
    expect(decision.scope).toBe("NONE");
    expect(decision.triggers).toHaveLength(0);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("no active plan fires INITIAL_GOAL at FULL scope", () => {
    const decision = evaluateTriggers(baseInput({ hasActivePlan: false }));
    expect(decision.scope).toBe("FULL");
    expect(decision.triggers.map((t) => t.name)).toContain("INITIAL_GOAL");
  });

  it("a single miss fires MISSED_SESSION at PATCH scope", () => {
    const decision = evaluateTriggers(baseInput({ missedInLast7d: 1 }));
    expect(decision.scope).toBe("PATCH");
    expect(decision.triggers.map((t) => t.name)).toEqual(["MISSED_SESSION"]);
  });

  it("three misses in 7 days escalate to MISSED_STREAK at FULL scope", () => {
    const decision = evaluateTriggers(baseInput({ missedInLast7d: 3 }));
    expect(decision.scope).toBe("FULL");
    expect(decision.triggers.map((t) => t.name)).toContain("MISSED_STREAK");
  });

  it("attendance below 60% fires MISSED_STREAK even with fewer than 3 misses", () => {
    const decision = evaluateTriggers(baseInput({ missedInLast7d: 1, attendance14d: 0.5 }));
    expect(decision.triggers.map((t) => t.name)).toContain("MISSED_STREAK");
    expect(decision.scope).toBe("FULL");
  });

  it("a significant prediction error fires HIGH_PREDICTION_ERROR at FULL scope", () => {
    const decision = evaluateTriggers(baseInput({ significantPredictionErrors: [{ subtopic_id: "dp_knapsack", prediction_error: -0.25 }] }));
    expect(decision.scope).toBe("FULL");
    expect(decision.triggers.map((t) => t.name)).toContain("HIGH_PREDICTION_ERROR");
  });

  it("a low score on one weighted subtopic is PATCH scope; two or more escalate to FULL", () => {
    const one = evaluateTriggers(baseInput({ lowScoreSubtopics: [{ subtopic_id: "dp_knapsack", score: 0.4 }] }));
    expect(one.triggers.find((t) => t.name === "LOW_SCORE")?.scope).toBe("PATCH");
    expect(one.scope).toBe("PATCH");

    const two = evaluateTriggers(
      baseInput({ lowScoreSubtopics: [{ subtopic_id: "dp_knapsack", score: 0.4 }, { subtopic_id: "gr_bfs", score: 0.3 }] }),
    );
    expect(two.triggers.find((t) => t.name === "LOW_SCORE")?.scope).toBe("FULL");
    expect(two.scope).toBe("FULL");
  });

  it("HIGH_PREDICTION_ERROR and LOW_SCORE from the same bad assessment coalesce into one FULL run", () => {
    const decision = evaluateTriggers(
      baseInput({
        significantPredictionErrors: [{ subtopic_id: "dp_knapsack", prediction_error: -0.25 }],
        lowScoreSubtopics: [{ subtopic_id: "dp_knapsack", score: 0.4 }],
      }),
    );
    expect(decision.scope).toBe("FULL");
    expect(decision.triggers.map((t) => t.name).sort()).toEqual(["HIGH_PREDICTION_ERROR", "LOW_SCORE"].sort());
    expect(decision.reason).toContain("coalesced");
  });

  it("buffer under 3 days fires DEADLINE_RISK at FULL scope", () => {
    const decision = evaluateTriggers(baseInput({ bufferDays: 1.5 }));
    expect(decision.scope).toBe("FULL");
    expect(decision.triggers.map((t) => t.name)).toContain("DEADLINE_RISK");
  });

  it("availability change over 20% fires AVAILABILITY_CHANGE at FULL scope", () => {
    const decision = evaluateTriggers(baseInput({ availabilityDeltaRatio: 0.6 }));
    expect(decision.scope).toBe("FULL");
    expect(decision.triggers.map((t) => t.name)).toContain("AVAILABILITY_CHANGE");
  });

  it("a small availability change under 20% does not fire", () => {
    const decision = evaluateTriggers(baseInput({ availabilityDeltaRatio: 0.05 }));
    expect(decision.scope).toBe("NONE");
  });

  it("retention decay below target fires ACTIVE_RECALL_FAILURE pre-emptively, with no failure event", () => {
    const decision = evaluateTriggers(baseInput({ preemptiveRecallSubtopics: ["tr_bst"] }));
    expect(decision.scope).toBe("PATCH");
    expect(decision.triggers.map((t) => t.name)).toContain("ACTIVE_RECALL_FAILURE");
  });

  it("FEASIBILITY_BREACH is not evaluated here — negotiate scope never comes from this function", () => {
    const decision = evaluateTriggers(baseInput({ bufferDays: -10, missedInLast7d: 5, attendance14d: 0.2 }));
    expect(decision.scope).not.toBe("NEGOTIATE");
  });

  it("debounces a repeat of the same trigger class within 6 simulated hours", () => {
    const now = new Date("2026-11-10T08:00:00Z");
    const recentlyFiredAt = { MISSED_SESSION: new Date("2026-11-10T05:00:00Z") };
    const decision = evaluateTriggers(baseInput({ missedInLast7d: 1, now, recentlyFiredAt }));
    expect(decision.scope).toBe("NONE");
    expect(decision.debounced).toContain("MISSED_SESSION");
  });

  it("does not debounce the same trigger class after the 6-hour window has passed", () => {
    const now = new Date("2026-11-10T08:00:00Z");
    const recentlyFiredAt = { MISSED_SESSION: new Date("2026-11-10T01:00:00Z") };
    const decision = evaluateTriggers(baseInput({ missedInLast7d: 1, now, recentlyFiredAt }));
    expect(decision.scope).toBe("PATCH");
    expect(decision.debounced).toHaveLength(0);
  });

  it("PATCH-scope decisions carry patch_operations; FULL-scope decisions do not", () => {
    const patch = evaluateTriggers(baseInput({ missedInLast7d: 1 }));
    expect(patch.patch_operations?.length).toBeGreaterThan(0);

    const full = evaluateTriggers(baseInput({ hasActivePlan: false }));
    expect(full.patch_operations).toBeUndefined();
  });

  it("resource feedback fires RESOURCE_FAILURE and a tool recovery fires TOOL_RECOVERED, both PATCH", () => {
    const resourceDecision = evaluateTriggers(baseInput({ resourceFailures: [{ resource_id: "res_112" }] }));
    expect(resourceDecision.scope).toBe("PATCH");
    expect(resourceDecision.triggers.map((t) => t.name)).toContain("RESOURCE_FAILURE");

    const recoveredDecision = evaluateTriggers(baseInput({ recoveredTools: ["rag"] }));
    expect(recoveredDecision.scope).toBe("PATCH");
    expect(recoveredDecision.triggers.map((t) => t.name)).toContain("TOOL_RECOVERED");
  });

  it("a new calendar conflict fires CALENDAR_CONFLICT at PATCH scope", () => {
    const decision = evaluateTriggers(baseInput({ calendarConflicts: [{ activity_id: "a1", subtopic_id: "arr_traversal" }] }));
    expect(decision.scope).toBe("PATCH");
    expect(decision.triggers.map((t) => t.name)).toContain("CALENDAR_CONFLICT");
  });
});
