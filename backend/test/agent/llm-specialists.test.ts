import { describe, expect, it, vi } from "vitest";
import type { GapEntry, ScoredResource } from "../../src/core/types.js";

// structuredCompletion is mocked so these tests exercise only the
// post-validation safety logic in specialists.ts — no DB, no network.
const structuredCompletion = vi.fn();
vi.mock("../../src/agent/llm/service.js", () => ({ structuredCompletion: (...args: unknown[]) => structuredCompletion(...args) }));

const { runDiagnostician, runCurator, runStrategist, validateNegotiationMessage } = await import("../../src/agent/llm/specialists.js");

const ctx = {} as never;

function gap(subtopic_id: string, priority: number, action: GapEntry["action"] = "LEARN"): GapEntry {
  return { subtopic_id, priority, action, gap_snapshot: { gap: 0, severity: 0, blocking_term: 0, urgency: 0, learnability: 0, uncertainty: 0, retention_risk: 0 } };
}

function resource(id: string, fit: number): ScoredResource {
  return { resource_id: id, fit, breakdown: { level_match: 0, duration_fit: 0, quality: 0, format_match: 0, novelty: 0, concept_hit: 0 } };
}

describe("Diagnostician post-validation", () => {
  it("falls back when the model names a concept outside the supplied list", async () => {
    structuredCompletion.mockResolvedValueOnce({ source: "llm", value: { subtopic_id: "bfs", root_cause_concept: "invented_concept", evidence: "e", implication: "i", recommended_resource_profile: { type: "practice", difficulty: 3, focus_concept: "invented_concept" }, confidence: "high" } });
    const result = await runDiagnostician({ ctx, subtopicId: "bfs", concepts: ["queue_usage", "visited_set"], fallbackConcept: "queue_usage", input: { mu: 0.3 } });
    expect(result.source).toBe("fallback");
    expect(result.value.root_cause_concept).toBe("queue_usage");
  });
});

describe("Curator post-validation", () => {
  it("falls back to the top-fit resource when the chosen id is outside the candidate set", async () => {
    structuredCompletion.mockResolvedValueOnce({ source: "llm", value: { chosen_resource_id: "not-a-candidate", justification: "j", expected_usefulness: 0.9 } });
    const candidates = [resource("r1", 0.8), resource("r2", 0.6)];
    const result = await runCurator({ ctx, candidates, input: {} });
    expect(result?.source).toBe("fallback");
    expect(result?.value.chosen_resource_id).toBe("r1");
  });
});

describe("Strategist post-validation", () => {
  it("discards the whole response when any subtopic id is unknown", async () => {
    structuredCompletion.mockResolvedValueOnce({ source: "llm", value: { actions: [{ subtopic_id: "does_not_exist", action: "PRACTICE", overrides_baseline: true, rationale: "r" }], budget_allocation: [], strategy_note: "n" } });
    const gaps = [gap("a", 10), gap("b", 5)];
    const result = await runStrategist({ ctx, gaps, availableHours: 10, requiredHours: 8, unmetPrerequisites: new Set(), deadline: "2026-01-01", simNow: "2025-12-01" });
    expect(result.source).toBe("fallback");
    expect(result.actions.get("a")).toBe("LEARN");
  });

  it("caps overrides at 3, keeping the highest-priority ones and logging the discard count", async () => {
    const gaps = [gap("a", 90), gap("b", 80), gap("c", 70), gap("d", 60), gap("e", 10)];
    const actions = gaps.map((g) => ({ subtopic_id: g.subtopic_id, action: "PRACTICE" as const, overrides_baseline: true, rationale: "r" }));
    structuredCompletion.mockResolvedValueOnce({ source: "llm", value: { actions, budget_allocation: [], strategy_note: "n" } });
    const result = await runStrategist({ ctx, gaps, availableHours: 10, requiredHours: 8, unmetPrerequisites: new Set(), deadline: "2026-01-01", simNow: "2025-12-01" });
    expect(result.cappedOverrides).toBe(2);
    expect(["a", "b", "c"].every((id) => result.actions.get(id) === "PRACTICE")).toBe(true);
    expect(result.actions.get("e")).toBe("LEARN");
  });

  it("reverts a LEARN override on a subtopic with an unmet prerequisite", async () => {
    const gaps = [gap("a", 10)];
    structuredCompletion.mockResolvedValueOnce({ source: "llm", value: { actions: [{ subtopic_id: "a", action: "LEARN", overrides_baseline: true, rationale: "r" }], budget_allocation: [], strategy_note: "n" } });
    const result = await runStrategist({ ctx, gaps: [gap("a", 10, "PRACTICE")], availableHours: 10, requiredHours: 8, unmetPrerequisites: new Set(["a"]), deadline: "2026-01-01", simNow: "2025-12-01" });
    expect(result.actions.get("a")).toBe("PRACTICE");
  });

  it("discards a budget proposal over 1.5x available hours in favor of the proportional split", async () => {
    const gaps = [gap("a", 10), gap("b", 10)];
    structuredCompletion.mockResolvedValueOnce({ source: "llm", value: { actions: [], budget_allocation: [{ subtopic_id: "a", hours: 100 }, { subtopic_id: "b", hours: 100 }], strategy_note: "n" } });
    const result = await runStrategist({ ctx, gaps, availableHours: 10, requiredHours: 8, unmetPrerequisites: new Set(), deadline: "2026-01-01", simNow: "2025-12-01" });
    expect(result.budgetHours.get("a")).toBeCloseTo(5);
    expect(result.budgetHours.get("b")).toBeCloseTo(5);
  });
});

describe("validateNegotiationMessage", () => {
  const options = [{ label: "A", description: "Extend the deadline by 4 days.", cost: 0.33 }];

  it("rejects a message with a numeral absent from the computed options", () => {
    expect(validateNegotiationMessage("Extending by 6 days closes the gap.", options)).toBeUndefined();
  });

  it("keeps a message whose numerals all appear in the computed options", () => {
    expect(validateNegotiationMessage("A 4-day extension is the cheapest option at 0.33.", options)).toBe("A 4-day extension is the cheapest option at 0.33.");
  });

  it("passes through undefined untouched", () => {
    expect(validateNegotiationMessage(undefined, options)).toBeUndefined();
  });
});
