import { describe, it, expect } from "vitest";
import { selectAction } from "../../src/core/actionSelector.js";
import type { ActionSelectorInput } from "../../src/core/types.js";

function input(overrides: Partial<ActionSelectorInput> = {}): ActionSelectorInput {
  return {
    evidence_count: 5,
    confidence: 0.5,
    blueprint_weight: 0.15,
    has_completed_learning: true,
    retention_estimate: 0.7,
    target_mastery: 0.75,
    is_repeated_weakness: false,
    mu: 0.5,
    all_learn_practice_complete: false,
    has_final_test: false,
    ...overrides,
  };
}

describe("action selector — bloom-phase4-brief §4.2 corrected ordering", () => {
  it("memoization (thin evidence, low confidence, meaningful weight) -> IMMEDIATE_TEST", () => {
    const action = selectAction(
      input({ evidence_count: 2, confidence: 0.30, blueprint_weight: 0.20, has_completed_learning: false, retention_estimate: 0.26, mu: 0.30 }),
    );
    expect(action).toBe("IMMEDIATE_TEST");
  });

  it("never-studied subtopic with low retention -> LEARN, not ACTIVE_RECALL", () => {
    // retention_estimate is low precisely BECAUSE mu/confidence are low for a subtopic
    // never opened — rule 2 must fire before rule 3 checks retention at all.
    const action = selectAction(
      input({ evidence_count: 0, confidence: 0.1, has_completed_learning: false, retention_estimate: 0.20, mu: 0.05 }),
    );
    expect(action).toBe("LEARN");
    expect(action).not.toBe("ACTIVE_RECALL");
  });

  it("studied subtopic with retention below target*0.8 -> ACTIVE_RECALL", () => {
    const action = selectAction(
      input({ evidence_count: 10, confidence: 0.6, has_completed_learning: true, retention_estimate: 0.5, target_mastery: 0.75 }),
    );
    expect(action).toBe("ACTIVE_RECALL");
  });

  it("evidence_count 12 with low confidence is not IMMEDIATE_TEST (past the evidence window)", () => {
    const action = selectAction(
      input({ evidence_count: 12, confidence: 0.2, blueprint_weight: 0.3, has_completed_learning: true, retention_estimate: 0.9 }),
    );
    expect(action).not.toBe("IMMEDIATE_TEST");
  });

  it("repeated concept weakness -> REVISION", () => {
    const action = selectAction(
      input({ has_completed_learning: true, retention_estimate: 0.9, is_repeated_weakness: true, mu: 0.4, target_mastery: 0.75 }),
    );
    expect(action).toBe("REVISION");
  });

  it("mu below target, no other trigger -> PRACTICE", () => {
    const action = selectAction(
      input({ has_completed_learning: true, retention_estimate: 0.9, is_repeated_weakness: false, mu: 0.5, target_mastery: 0.75 }),
    );
    expect(action).toBe("PRACTICE");
  });

  it("mu >= target, all learn/practice complete, no final test yet -> FINAL_TEST", () => {
    const action = selectAction(
      input({ has_completed_learning: true, retention_estimate: 0.9, mu: 0.8, target_mastery: 0.75, all_learn_practice_complete: true, has_final_test: false }),
    );
    expect(action).toBe("FINAL_TEST");
  });

  it("mu >= target, final test already exists -> NONE", () => {
    const action = selectAction(
      input({ has_completed_learning: true, retention_estimate: 0.9, mu: 0.8, target_mastery: 0.75, all_learn_practice_complete: true, has_final_test: true }),
    );
    expect(action).toBe("NONE");
  });

  it("blueprint_weight at or below the immediate-test threshold does not qualify", () => {
    const action = selectAction(
      input({ evidence_count: 2, confidence: 0.2, blueprint_weight: 0.10, has_completed_learning: false, retention_estimate: 0.1, mu: 0.1 }),
    );
    expect(action).toBe("LEARN");
  });
});
