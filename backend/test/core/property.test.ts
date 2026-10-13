import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { applyObservation } from "../../src/core/belief.js";
import { BELIEF } from "../../src/core/constants.js";
import type { Observation, SubtopicBelief } from "../../src/core/types.js";
import { makeBelief } from "./fixtures.js";

const difficultyArb = fc.constantFrom(1, 2, 3, 4, 5) as fc.Arbitrary<1 | 2 | 3 | 4 | 5>;

const observationArb: fc.Arbitrary<Omit<Observation, "source_id">> = fc.record({
  n: fc.integer({ min: 0, max: 20 }),
  difficulty: difficultyArb,
  score: fc.double({ min: 0, max: 1, noNaN: true }),
});

function applySequence(seed: SubtopicBelief, obs: Omit<Observation, "source_id">[]): SubtopicBelief {
  let belief = seed;
  let start = new Date("2026-01-01T00:00:00Z").getTime();
  for (let i = 0; i < obs.length; i++) {
    start += 3_600_000 * (i + 1); // always move forward in time
    const now = new Date(start);
    const result = applyObservation(belief, { ...obs[i], source_id: `o${i}` }, now);
    belief = result.belief;
  }
  return belief;
}

describe("belief property tests", () => {
  it("mu stays within [0,1] after any sequence of random observations", () => {
    fc.assert(
      fc.property(fc.array(observationArb, { minLength: 0, maxLength: 30 }), (obsList) => {
        const belief = applySequence(makeBelief({ mu: 0.5, confidence: 0.3 }), obsList);
        expect(belief.mu).toBeGreaterThanOrEqual(0);
        expect(belief.mu).toBeLessThanOrEqual(1);
      }),
      { numRuns: 10_000 },
    );
  });

  it("confidence stays within [0,1] always", () => {
    fc.assert(
      fc.property(fc.array(observationArb, { minLength: 0, maxLength: 30 }), (obsList) => {
        const belief = applySequence(makeBelief({ mu: 0.5, confidence: 0.3 }), obsList);
        expect(belief.confidence).toBeGreaterThanOrEqual(0);
        expect(belief.confidence).toBeLessThanOrEqual(1);
      }),
      { numRuns: 10_000 },
    );
  });

  it("learn_rate stays within bounds always", () => {
    const [lo, hi] = BELIEF.learn_rate_bounds;
    fc.assert(
      fc.property(fc.array(observationArb, { minLength: 0, maxLength: 30 }), (obsList) => {
        const belief = applySequence(makeBelief({ mu: 0.5, confidence: 0.3 }), obsList);
        expect(belief.learn_rate).toBeGreaterThanOrEqual(lo);
        expect(belief.learn_rate).toBeLessThanOrEqual(hi);
      }),
      { numRuns: 10_000 },
    );
  });

  it("no NaN or Infinity reachable, including n=0 and score=0", () => {
    fc.assert(
      fc.property(fc.array(observationArb, { minLength: 0, maxLength: 30 }), (obsList) => {
        const belief = applySequence(makeBelief({ mu: 0.5, confidence: 0.3 }), obsList);
        for (const value of [belief.mu, belief.confidence, belief.learn_rate, belief.prediction_error_ema]) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }),
      { numRuns: 10_000 },
    );

    // explicit edge cases
    const belief = applySequence(makeBelief({ mu: 0.5, confidence: 0.3 }), [
      { n: 0, difficulty: 3, score: 0 },
      { n: 0, difficulty: 1, score: 0 },
    ]);
    expect(Number.isFinite(belief.mu)).toBe(true);
    expect(Number.isFinite(belief.confidence)).toBe(true);
    expect(Number.isFinite(belief.learn_rate)).toBe(true);
  });

  it("a sequence of perfect scores never decreases mu", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }), (count, n) => {
        let belief = makeBelief({ mu: 0.3, confidence: 0.2, last_observed_at: null });
        let start = new Date("2026-01-01T00:00:00Z").getTime();
        for (let i = 0; i < count; i++) {
          start += 3_600_000 * 24; // a day apart, well past the recalibration floor
          const now = new Date(start);
          const prevMu = belief.mu;
          const result = applyObservation(belief, { source_id: `p${i}`, n, difficulty: 3, score: 1 }, now);
          belief = result.belief;
          expect(belief.mu).toBeGreaterThanOrEqual(prevMu - 1e-9);
        }
      }),
      { numRuns: 10_000 },
    );
  });
});
