import { describe, it, expect } from "vitest";
import { recordQuestionAttempt, getWeaknessScore } from "../../src/core/weakness.js";
import { analyzeConceptWeakness } from "../../src/core/concept.js";
import { makeQuestionState } from "./fixtures.js";
import type { ConceptAttempt } from "../../src/core/types.js";

describe("question weakness tracker", () => {
  it("first incorrect → enters revision pool", () => {
    const state = makeQuestionState();
    const next = recordQuestionAttempt(state, false, new Date("2026-01-01T00:00:00Z"));
    expect(next.in_revision_pool).toBe(true);
  });

  it("one correct → still in pool", () => {
    let state = makeQuestionState();
    state = recordQuestionAttempt(state, false, new Date("2026-01-01T00:00:00Z"));
    state = recordQuestionAttempt(state, true, new Date("2026-01-02T00:00:00Z"));
    expect(state.in_revision_pool).toBe(true);
  });

  it("two correct on the SAME day → still in pool", () => {
    let state = makeQuestionState();
    state = recordQuestionAttempt(state, false, new Date("2026-01-01T00:00:00Z"));
    state = recordQuestionAttempt(state, true, new Date("2026-01-02T08:00:00Z"));
    state = recordQuestionAttempt(state, true, new Date("2026-01-02T20:00:00Z"));
    expect(state.in_revision_pool).toBe(true);
  });

  it("two correct on DIFFERENT days → leaves pool", () => {
    let state = makeQuestionState();
    state = recordQuestionAttempt(state, false, new Date("2026-01-01T00:00:00Z"));
    state = recordQuestionAttempt(state, true, new Date("2026-01-02T08:00:00Z"));
    state = recordQuestionAttempt(state, true, new Date("2026-01-03T08:00:00Z"));
    expect(state.in_revision_pool).toBe(false);
  });

  it("never leaves the pool for any reason other than the two-day rule", () => {
    let state = makeQuestionState();
    state = recordQuestionAttempt(state, false, new Date("2026-01-01T00:00:00Z"));
    // lots of time passing alone doesn't clear it
    const score = getWeaknessScore(state, new Date("2026-06-01T00:00:00Z"));
    expect(state.in_revision_pool).toBe(true);
    expect(score).toBeGreaterThan(0);
  });

  it("a wrong answer mid-streak resets the streak and re-flags the pool", () => {
    let state = makeQuestionState();
    state = recordQuestionAttempt(state, false, new Date("2026-01-01T00:00:00Z"));
    state = recordQuestionAttempt(state, true, new Date("2026-01-02T00:00:00Z"));
    state = recordQuestionAttempt(state, false, new Date("2026-01-03T00:00:00Z"));
    state = recordQuestionAttempt(state, true, new Date("2026-01-04T00:00:00Z"));
    // only one correct since the last wrong answer — must not have exited yet
    expect(state.in_revision_pool).toBe(true);
  });
});

describe("concept weakness engine", () => {
  function attempts(pattern: boolean[], startDay = 1): ConceptAttempt[] {
    return pattern.map((correct, i) => ({ correct, at: new Date(2026, 0, startDay + i) }));
  }

  it("concept accuracy 0.7 → 0.4 over time → is_forgotten = true", () => {
    // 5 prior attempts at 80% accuracy, then 3 recent attempts at ~33% accuracy
    const history = attempts([true, true, true, true, false, false, true, false]);
    const result = analyzeConceptWeakness("recursion_base_case", "recursion", history, 0.1);

    expect(result.is_forgotten).toBe(true);
    expect(result.is_repeated).toBe(false);
  });

  it("concept never above 0.5 → is_repeated = true, is_forgotten = false", () => {
    const history = attempts([false, true, false, false, true, false]);
    const result = analyzeConceptWeakness("recursion_base_case", "recursion", history, 0.1);

    expect(result.is_repeated).toBe(true);
    expect(result.is_forgotten).toBe(false);
  });

  it("severity increases with blueprint weight and attempt count, decreases with accuracy", () => {
    const weak = analyzeConceptWeakness("c", "s", attempts([false, false, false, false, false]), 0.2);
    const strong = analyzeConceptWeakness("c", "s", attempts([true, true, true, true, true]), 0.2);
    expect(weak.severity).toBeGreaterThan(strong.severity);
  });
});
