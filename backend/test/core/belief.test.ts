import { describe, it, expect } from "vitest";
import { applyObservation } from "../../src/core/belief.js";
import { makeBelief } from "./fixtures.js";

describe("belief updater", () => {
  it("★ canonical case: mu 0.68, conf 0.55, 8×medium @ 0.40", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    const lastObservedAt = new Date("2026-01-10T10:00:00Z"); // 2 hours earlier
    const belief = makeBelief({
      mu: 0.68,
      confidence: 0.55,
      learn_rate: 0.12,
      last_observed_at: lastObservedAt,
      mu_at_last_observation: 0.5,
    });

    const { belief: next, delta } = applyObservation(
      belief,
      { source_id: "a1", n: 8, difficulty: 3, score: 0.4 },
      now,
    );

    expect(next.mu).toBeCloseTo(0.581, 3);
    expect(next.confidence).toBeCloseTo(0.775, 3);
    expect(delta?.mu_after).toBeCloseTo(0.581, 3);
    expect(delta?.confidence_after).toBeCloseTo(0.775, 3);
  });

  it("★ learn rate: 0.12 with predicted_gain 0.240, actual 0.0813 → 0.080", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    const lastObservedAt = new Date("2026-01-10T10:00:00Z");
    const belief = makeBelief({
      mu: 0.68,
      confidence: 0.55,
      learn_rate: 0.12,
      last_observed_at: lastObservedAt,
      mu_at_last_observation: 0.5,
    });

    const { belief: next } = applyObservation(belief, { source_id: "a1", n: 8, difficulty: 3, score: 0.4 }, now);

    expect(next.learn_rate).toBeCloseTo(0.08, 2);
  });

  it("low confidence moves mu further than high confidence on identical evidence", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    const lowConf = makeBelief({ mu: 0.5, confidence: 0.1, last_observed_at: null });
    const highConf = makeBelief({ mu: 0.5, confidence: 0.9, last_observed_at: null });

    const obs = { source_id: "a1", n: 8, difficulty: 3 as const, score: 0.9 };
    const lowResult = applyObservation(lowConf, obs, now);
    const highResult = applyObservation(highConf, obs, now);

    const lowMove = Math.abs(lowResult.belief.mu - 0.5);
    const highMove = Math.abs(highResult.belief.mu - 0.5);
    expect(lowMove).toBeGreaterThan(highMove);
  });

  it("hard questions move mu more than easy questions on identical score", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    const easy = makeBelief({ mu: 0.5, confidence: 0.5, last_observed_at: null });
    const hard = makeBelief({ mu: 0.5, confidence: 0.5, last_observed_at: null });

    const easyResult = applyObservation(easy, { source_id: "a1", n: 8, difficulty: 1, score: 0.9 }, now);
    const hardResult = applyObservation(hard, { source_id: "a1", n: 8, difficulty: 5, score: 0.9 }, now);

    const easyMove = easyResult.belief.mu - 0.5;
    const hardMove = hardResult.belief.mu - 0.5;
    expect(hardMove).toBeGreaterThan(easyMove);
  });

  it("2 questions moves mu less than 8 questions on identical score", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    const few = makeBelief({ mu: 0.5, confidence: 0.5, last_observed_at: null });
    const many = makeBelief({ mu: 0.5, confidence: 0.5, last_observed_at: null });

    const fewResult = applyObservation(few, { source_id: "a1", n: 2, difficulty: 3, score: 0.9 }, now);
    const manyResult = applyObservation(many, { source_id: "a1", n: 8, difficulty: 3, score: 0.9 }, now);

    const fewMove = Math.abs(fewResult.belief.mu - 0.5);
    const manyMove = Math.abs(manyResult.belief.mu - 0.5);
    expect(fewMove).toBeLessThan(manyMove);
  });

  it("confidence never decreases on observation", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    const belief = makeBelief({ mu: 0.8, confidence: 0.6, last_observed_at: null });

    // even a terrible score should not lower confidence
    const { belief: next } = applyObservation(belief, { source_id: "a1", n: 8, difficulty: 3, score: 0.0 }, now);
    expect(next.confidence).toBeGreaterThanOrEqual(belief.confidence);
  });

  it("applying the same observation twice (same source_id) is a no-op", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    const belief = makeBelief({ mu: 0.5, confidence: 0.5, last_observed_at: null });
    const obs = { source_id: "a1", n: 8, difficulty: 3 as const, score: 0.9 };

    const first = applyObservation(belief, obs, now);
    const appliedIds = new Set([obs.source_id]);
    const second = applyObservation(first.belief, obs, now, appliedIds);

    expect(second.delta).toBeNull();
    expect(second.belief).toEqual(first.belief);
  });

  it("mu and confidence are clamped even from a corrupted out-of-range seed belief", () => {
    // alpha*w is always < 1 for in-range confidence/score, so a single step is a
    // convex combination and self-bounds. n=0 (zero evidence weight) plus an
    // out-of-range seed is the case that actually needs the clamp to matter.
    const now = new Date("2026-01-10T12:00:00Z");
    const belief = makeBelief({ mu: 1.4, confidence: 1.4, last_observed_at: null });

    const { belief: next } = applyObservation(belief, { source_id: "a1", n: 0, difficulty: 3, score: 0 }, now);

    expect(next.mu).toBeLessThanOrEqual(1);
    expect(next.confidence).toBeLessThanOrEqual(1);
  });

  it("recalibration skipped when hours_since < 0.5", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    const lastObservedAt = new Date("2026-01-10T11:45:00Z"); // 0.25 hours earlier
    const belief = makeBelief({
      mu: 0.68,
      confidence: 0.55,
      learn_rate: 0.12,
      last_observed_at: lastObservedAt,
      mu_at_last_observation: 0.5,
    });

    const { belief: next } = applyObservation(belief, { source_id: "a1", n: 8, difficulty: 3, score: 0.4 }, now);

    expect(next.learn_rate).toBe(0.12);
  });
});
