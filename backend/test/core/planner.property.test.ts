import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildGapTable } from "../../src/core/gapEngine.js";
import { buildPlan } from "../../src/core/planner.js";
import { generateSlots } from "../../src/core/slotter.js";
import type { GapEngineInput, WeeklyAvailability } from "../../src/core/types.js";
import { CHAIN_IDS, makeGoal, makePlannerBelief, makeRecallProposal, makeResourceMap, makeTopicGraph } from "./plannerFixtures.js";

const SIM_NOW = new Date("2026-11-01T00:00:00Z");
const DAILY_WINDOW: WeeklyAvailability = (() => {
  const w = [{ start: "18:00", end: "20:00" }]; // 2h/day, every day
  return { "0": w, "1": w, "2": w, "3": w, "4": w, "5": w, "6": w };
})();

const subtopicScenarioArb = fc.record({
  mu: fc.double({ min: 0, max: 1, noNaN: true }),
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
  learn_rate: fc.double({ min: 0.05, max: 0.3, noNaN: true }),
  evidence_count: fc.integer({ min: 0, max: 12 }),
  has_completed_learning: fc.boolean(),
  retention_estimate: fc.double({ min: 0, max: 1, noNaN: true }),
  is_repeated_weakness: fc.boolean(),
  all_learn_practice_complete: fc.boolean(),
  has_final_test: fc.boolean(),
  unmastered_dependent_count: fc.integer({ min: 0, max: 2 }),
});

type SubtopicScenario = {
  mu: number;
  confidence: number;
  learn_rate: number;
  evidence_count: number;
  has_completed_learning: boolean;
  retention_estimate: number;
  is_repeated_weakness: boolean;
  all_learn_practice_complete: boolean;
  has_final_test: boolean;
  unmastered_dependent_count: number;
};

type Scenario = { a: SubtopicScenario; b: SubtopicScenario; c: SubtopicScenario; deadlineDays: number; recallCount: number };

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  a: subtopicScenarioArb,
  b: subtopicScenarioArb,
  c: subtopicScenarioArb,
  deadlineDays: fc.integer({ min: 30, max: 90 }),
  recallCount: fc.integer({ min: 0, max: 2 }),
});

function buildScenarioPlan(scenario: Scenario) {
  const deadline = new Date(SIM_NOW.getTime() + scenario.deadlineDays * 86_400_000);
  const goal = makeGoal({ deadline });
  const topicGraph = makeTopicGraph();

  const scenarios = { p_a: scenario.a, p_b: scenario.b, p_c: scenario.c };
  const inputs: GapEngineInput[] = CHAIN_IDS.map((id) => {
    const s = scenarios[id as keyof typeof scenarios];
    return {
      subtopic_id: id,
      mu: s.mu,
      confidence: s.confidence,
      learn_rate: s.learn_rate,
      target_mastery: 0.75,
      blueprint_weight: goal.blueprint[id],
      retention_estimate: s.retention_estimate,
      unmastered_dependent_count: s.unmastered_dependent_count,
      days_until_needed: scenario.deadlineDays,
      evidence_count: s.evidence_count,
      has_completed_learning: s.has_completed_learning,
      is_repeated_weakness: s.is_repeated_weakness,
      all_learn_practice_complete: s.all_learn_practice_complete,
      has_final_test: s.has_final_test,
    };
  });
  const gapTable = buildGapTable(inputs);

  const beliefs = CHAIN_IDS.map((id) => {
    const s = scenarios[id as keyof typeof scenarios];
    return makePlannerBelief(id, { mu: s.mu, confidence: s.confidence, learn_rate: s.learn_rate });
  });

  const slots = generateSlots(
    { weekly_availability: DAILY_WINDOW, max_daily_study_min: 300, min_session_min: 15, max_session_min: 90, blackout_dates: [] },
    [],
    SIM_NOW,
    deadline,
    {},
  );

  const recallProposals = CHAIN_IDS.flatMap((id, idx) =>
    Array.from({ length: scenario.recallCount }, (_, i) =>
      makeRecallProposal(id, new Date(SIM_NOW.getTime() + (5 + i * 10 + idx) * 86_400_000), { interval_index: i }),
    ),
  );

  return buildPlan({
    goal,
    beliefs,
    gapTable,
    slots,
    resourceCandidates: makeResourceMap(CHAIN_IDS),
    recallProposals,
    topicGraph,
    simNow: SIM_NOW,
    degradedSignals: [],
  });
}

describe("planner property tests (bloom-phase4-brief §9)", () => {
  it("never produces overlapping activities", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const plan = buildScenarioPlan(scenario);
        const sorted = [...plan.activities].sort((a, b) => a.start.getTime() - b.start.getTime());
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].start.getTime()).toBeGreaterThanOrEqual(sorted[i - 1].end.getTime());
        }
      }),
      { numRuns: 50 },
    );
  });

  it("schedules a dependent's LEARN/PRACTICE activities only after its prerequisite's finish", () => {
    // Restricted to LEARN/PRACTICE: the topological order (§7.2 step 2) and the greedy
    // fill (step 3) are what guarantee this. Assessments placed afterward in step 4
    // (a final test, a recall) are best-effort and may land earlier — see the
    // planner.ts file header (§2): the validator, not the planner, is authoritative.
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const plan = buildScenarioPlan(scenario);
        const studyOnly = (id: string) => plan.activities.filter((a) => a.subtopic_id === id && (a.action === "LEARN" || a.action === "PRACTICE"));
        const aEnd = Math.max(0, ...studyOnly("p_a").map((a) => a.end.getTime()));
        const bStart = Math.min(Infinity, ...studyOnly("p_b").map((a) => a.start.getTime()));
        const bEnd = Math.max(0, ...studyOnly("p_b").map((a) => a.end.getTime()));
        const cStart = Math.min(Infinity, ...studyOnly("p_c").map((a) => a.start.getTime()));
        if (studyOnly("p_b").length > 0 && studyOnly("p_a").length > 0) expect(bStart).toBeGreaterThanOrEqual(aEnd);
        if (studyOnly("p_c").length > 0 && studyOnly("p_b").length > 0) expect(cStart).toBeGreaterThanOrEqual(bEnd);
      }),
      { numRuns: 50 },
    );
  });

  it("every activity has a finite, in-range predicted_score", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const plan = buildScenarioPlan(scenario);
        for (const a of plan.activities) {
          expect(Number.isFinite(a.predicted_score)).toBe(true);
          expect(a.predicted_score).toBeGreaterThanOrEqual(0);
          expect(a.predicted_score).toBeLessThanOrEqual(0.98);
        }
      }),
      { numRuns: 50 },
    );
  });

  it("never schedules an activity at or after the goal deadline", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const deadline = new Date(SIM_NOW.getTime() + scenario.deadlineDays * 86_400_000);
        const plan = buildScenarioPlan(scenario);
        for (const a of plan.activities) {
          expect(a.start.getTime()).toBeLessThan(deadline.getTime());
        }
      }),
      { numRuns: 50 },
    );
  });

  it("the fill-loop guard never trips given generous slot capacity", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const plan = buildScenarioPlan(scenario);
        // base_hours=2 per subtopic clamps hours_needed to at most 3h; three subtopics
        // need at most 9h against >=60h of available capacity over the shortest
        // (30-day) deadline in this generator, so a well-behaved loop never exhausts
        // slots or hits the 100-iteration guard.
        expect(plan.projection.unplaced_hours).toEqual({});
      }),
      { numRuns: 50 },
    );
  });
});
