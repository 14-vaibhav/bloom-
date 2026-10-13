import { describe, it, expect } from "vitest";
import { buildGapTable } from "../../src/core/gapEngine.js";
import { buildPlan } from "../../src/core/planner.js";
import { generateSlots } from "../../src/core/slotter.js";
import type { GapEngineInput, RecallProposal, ScoredResource, WeeklyAvailability } from "../../src/core/types.js";
import { CHAIN_IDS, makeGoal, makePlannerBelief, makeRecallProposal, makeTopicGraph } from "./plannerFixtures.js";

const SIM_NOW = new Date("2026-11-01T00:00:00Z");
const DEADLINE = new Date("2026-12-15T00:00:00Z");
const WINDOW: WeeklyAvailability = (() => {
  const w = [{ start: "18:00", end: "20:00" }];
  return { "0": w, "1": w, "2": w, "3": w, "4": w, "5": w, "6": w };
})();

function buildInput() {
  const goal = makeGoal({ deadline: DEADLINE });
  const topicGraph = makeTopicGraph();

  const inputs: GapEngineInput[] = [
    { subtopic_id: "p_a", mu: 0.4, confidence: 0.5, learn_rate: 0.12, target_mastery: 0.75, blueprint_weight: 0.3, retention_estimate: 0.5, unmastered_dependent_count: 1, days_until_needed: 30, evidence_count: 4, has_completed_learning: false, is_repeated_weakness: false, all_learn_practice_complete: false, has_final_test: false },
    { subtopic_id: "p_b", mu: 0.55, confidence: 0.6, learn_rate: 0.1, target_mastery: 0.75, blueprint_weight: 0.3, retention_estimate: 0.4, unmastered_dependent_count: 0, days_until_needed: 20, evidence_count: 6, has_completed_learning: true, is_repeated_weakness: false, all_learn_practice_complete: false, has_final_test: false },
    { subtopic_id: "p_c", mu: 0.8, confidence: 0.9, learn_rate: 0.09, target_mastery: 0.75, blueprint_weight: 0.4, retention_estimate: 0.85, unmastered_dependent_count: 0, days_until_needed: 40, evidence_count: 9, has_completed_learning: true, is_repeated_weakness: false, all_learn_practice_complete: true, has_final_test: false },
  ];
  const gapTable = buildGapTable(inputs);

  const beliefs = [
    makePlannerBelief("p_a", { mu: 0.4, confidence: 0.5, learn_rate: 0.12 }),
    makePlannerBelief("p_b", { mu: 0.55, confidence: 0.6, learn_rate: 0.1 }),
    makePlannerBelief("p_c", { mu: 0.8, confidence: 0.9, learn_rate: 0.09 }),
  ];

  const slots = generateSlots(
    { weekly_availability: WINDOW, max_daily_study_min: 300, min_session_min: 15, max_session_min: 90, blackout_dates: [] },
    [],
    SIM_NOW,
    DEADLINE,
    {},
  );

  const resourceCandidates = new Map<string, ScoredResource[]>();
  for (const id of CHAIN_IDS) {
    resourceCandidates.set(id, [
      { resource_id: `res_${id}_lo`, fit: 0.6, breakdown: { level_match: 0.6, duration_fit: 1, quality: 0.6, format_match: 0.6, novelty: 1, concept_hit: 0.5 } },
      { resource_id: `res_${id}_hi`, fit: 0.9, breakdown: { level_match: 0.9, duration_fit: 1, quality: 0.9, format_match: 0.9, novelty: 1, concept_hit: 1 } },
    ]);
  }

  const recallProposals: RecallProposal[] = [
    makeRecallProposal("p_b", new Date(SIM_NOW.getTime() + 6 * 86_400_000)),
    makeRecallProposal("p_c", new Date(SIM_NOW.getTime() + 9 * 86_400_000)),
  ];

  return { goal, beliefs, gapTable, slots, resourceCandidates, recallProposals, topicGraph, simNow: SIM_NOW, degradedSignals: [] as const };
}

describe("determinism (bloom-phase4-brief §8)", () => {
  it("identical input produces byte-identical (deep-equal) plans", () => {
    const input = buildInput();
    const planA = buildPlan({ ...input, degradedSignals: [...input.degradedSignals] });
    const planB = buildPlan({ ...input, degradedSignals: [...input.degradedSignals] });
    expect(planA).toEqual(planB);
  });

  it("shuffling every input array's order does not change the resulting plan", () => {
    const input = buildInput();
    const baseline = buildPlan({ ...input, degradedSignals: [...input.degradedSignals] });

    const shuffled = {
      ...input,
      gapTable: [...input.gapTable].reverse(),
      recallProposals: [...input.recallProposals].reverse(),
      resourceCandidates: new Map(
        [...input.resourceCandidates.entries()].map(([id, list]) => [id, [...list].reverse()] as const),
      ),
      degradedSignals: [...input.degradedSignals],
    };
    const reordered = buildPlan(shuffled);

    expect(reordered).toEqual(baseline);
  });

  it("a genuine priority tie is still resolved the same way regardless of gapTable order (§8 tie-break)", () => {
    // Two independent (no prerequisites) subtopics with identical inputs tie exactly on
    // priority. Without an explicit subtopic_id tie-break in the topological layer sort,
    // JS's stable sort would fall back to Set iteration order — which tracks first-insertion
    // order and therefore *does* depend on the caller's gapTable array order. This is the
    // regression net for that: it must fail if the tie-break is ever dropped.
    const goal = makeGoal({ blueprint: { p_a: 0.5, p_c: 0.5 }, target_mastery: { p_a: 0.75, p_c: 0.75 } });
    const topicGraph = { subtopic_ids: ["p_a", "p_c"], prerequisites: [], base_hours: { p_a: 2, p_c: 2 } };
    const tiedInput: GapEngineInput = {
      subtopic_id: "p_a",
      mu: 0.4,
      confidence: 0.5,
      learn_rate: 0.1,
      target_mastery: 0.75,
      blueprint_weight: 0.2,
      retention_estimate: 0.5,
      unmastered_dependent_count: 0,
      days_until_needed: 20,
      evidence_count: 6,
      has_completed_learning: false,
      is_repeated_weakness: false,
      all_learn_practice_complete: false,
      has_final_test: false,
    };
    const gapTable = buildGapTable([tiedInput, { ...tiedInput, subtopic_id: "p_c" }]);
    expect(gapTable[0].priority).toBe(gapTable[1].priority); // confirm this really is a tie

    const beliefs = [makePlannerBelief("p_a", { mu: 0.4, confidence: 0.5, learn_rate: 0.1 }), makePlannerBelief("p_c", { mu: 0.4, confidence: 0.5, learn_rate: 0.1 })];
    const slots = generateSlots(
      { weekly_availability: WINDOW, max_daily_study_min: 300, min_session_min: 15, max_session_min: 90, blackout_dates: [] },
      [],
      SIM_NOW,
      DEADLINE,
      {},
    );
    const resourceCandidates = new Map<string, ScoredResource[]>([
      ["p_a", [{ resource_id: "res_a", fit: 0.8, breakdown: { level_match: 0.8, duration_fit: 1, quality: 0.8, format_match: 0.8, novelty: 1, concept_hit: 0.5 } }]],
      ["p_c", [{ resource_id: "res_c", fit: 0.8, breakdown: { level_match: 0.8, duration_fit: 1, quality: 0.8, format_match: 0.8, novelty: 1, concept_hit: 0.5 } }]],
    ]);
    const common = { goal, beliefs, gapTable, slots, resourceCandidates, recallProposals: [], topicGraph, simNow: SIM_NOW, degradedSignals: [] as const };

    const baseline = buildPlan(common);
    const reordered = buildPlan({ ...common, gapTable: [...gapTable].reverse() });

    expect(reordered).toEqual(baseline);
  });
});
