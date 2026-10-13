import { describe, it, expect } from "vitest";
import { buildGapTable } from "../../src/core/gapEngine.js";
import type { GapEngineInput } from "../../src/core/types.js";

function entry(overrides: Partial<GapEngineInput> & { subtopic_id: string }): GapEngineInput {
  return {
    mu: 0.5,
    confidence: 0.5,
    learn_rate: 0.1,
    target_mastery: 0.75,
    blueprint_weight: 0.15,
    retention_estimate: 0.5,
    unmastered_dependent_count: 0,
    days_until_needed: 14,
    evidence_count: 5,
    has_completed_learning: true,
    is_repeated_weakness: false,
    all_learn_practice_complete: true,
    has_final_test: false,
    ...overrides,
  };
}

describe("gap engine — bloom-phase4-brief §3.3 worked example", () => {
  it("reproduces the four-subtopic priority table exactly", () => {
    const inputs: GapEngineInput[] = [
      entry({
        subtopic_id: "prefix_sum",
        mu: 0.82,
        confidence: 0.85,
        learn_rate: 0.14,
        blueprint_weight: 0.08,
        unmastered_dependent_count: 1,
        retention_estimate: 0.78,
        days_until_needed: 24,
        evidence_count: 8,
        has_completed_learning: true,
      }),
      entry({
        subtopic_id: "binary_search",
        mu: 0.45,
        confidence: 0.62,
        learn_rate: 0.08,
        blueprint_weight: 0.18,
        unmastered_dependent_count: 2,
        retention_estimate: 0.38,
        days_until_needed: 10,
        evidence_count: 10,
        has_completed_learning: true,
      }),
      entry({
        subtopic_id: "bfs",
        mu: 0.38,
        confidence: 0.71,
        learn_rate: 0.09,
        blueprint_weight: 0.16,
        unmastered_dependent_count: 1,
        retention_estimate: 0.33,
        days_until_needed: 14,
        evidence_count: 3,
        has_completed_learning: false,
      }),
      entry({
        subtopic_id: "memoization",
        mu: 0.30,
        confidence: 0.30,
        learn_rate: 0.06,
        blueprint_weight: 0.20,
        unmastered_dependent_count: 0,
        retention_estimate: 0.26,
        days_until_needed: 18,
        evidence_count: 2,
        has_completed_learning: false,
      }),
    ];

    const table = buildGapTable(inputs);
    const byId = Object.fromEntries(table.map((e) => [e.subtopic_id, e]));

    expect(byId.binary_search.priority).toBeCloseTo(68.7, 0);
    expect(byId.memoization.priority).toBeCloseTo(66.4, 0);
    expect(byId.bfs.priority).toBeCloseTo(57.1, 0);
    expect(byId.prefix_sum.priority).toBeCloseTo(8.0, 0);

    // the demo line: biggest gap of the four, but a 10-minute test, not hours of study
    expect(byId.memoization.gap_snapshot.gap).toBeCloseTo(0.45, 5);
    expect(byId.memoization.action).toBe("IMMEDIATE_TEST");
    expect(byId.binary_search.action).toBe("ACTIVE_RECALL");
    expect(byId.bfs.action).toBe("LEARN");
    expect(byId.prefix_sum.action).toBe("FINAL_TEST");
  });

  it("raw factors match the brief's intermediate table", () => {
    const table = buildGapTable([
      entry({ subtopic_id: "binary_search", mu: 0.45, confidence: 0.62, learn_rate: 0.08, blueprint_weight: 0.18, unmastered_dependent_count: 2, retention_estimate: 0.38, days_until_needed: 10 }),
      entry({ subtopic_id: "prefix_sum", mu: 0.82, confidence: 0.85, learn_rate: 0.14, blueprint_weight: 0.08, unmastered_dependent_count: 1, retention_estimate: 0.78, days_until_needed: 24 }),
    ]);
    const bs = table.find((e) => e.subtopic_id === "binary_search")!;
    expect(bs.gap_snapshot.severity).toBeCloseTo(0.054, 4);
    expect(bs.gap_snapshot.blocking_term).toBeCloseTo(0.0432, 4);
    expect(bs.gap_snapshot.urgency).toBeCloseTo(0.4118, 3);
    expect(bs.gap_snapshot.learnability).toBeCloseTo(0.5714, 3);
    expect(bs.gap_snapshot.uncertainty).toBeCloseTo(0.095, 4);
    expect(bs.gap_snapshot.retention_risk).toBeCloseTo(0.0666, 4);
  });
});

describe("gap engine — edge cases", () => {
  it("normalises an all-equal factor column to 0.5 instead of dividing by zero", () => {
    const identical = entry({ subtopic_id: "x" });
    const table = buildGapTable([identical, { ...identical, subtopic_id: "y" }, { ...identical, subtopic_id: "z" }]);
    for (const e of table) {
      expect(e.priority).toBeCloseTo(50, 5);
      expect(Number.isFinite(e.priority)).toBe(true);
    }
  });

  it("produces no NaN for a single subtopic", () => {
    const table = buildGapTable([entry({ subtopic_id: "solo", learn_rate: 0 })]);
    expect(table).toHaveLength(1);
    expect(Number.isFinite(table[0].priority)).toBe(true);
  });

  it("gap and severity are zero once mu is above target", () => {
    const table = buildGapTable([entry({ subtopic_id: "done", mu: 0.9, target_mastery: 0.75 })]);
    expect(table[0].gap_snapshot.gap).toBe(0);
    expect(table[0].gap_snapshot.severity).toBe(0);
  });

  it("returns an empty table for an empty candidate set", () => {
    expect(buildGapTable([])).toEqual([]);
  });
});
