import { describe, it, expect } from "vitest";
import { applyDecay, computeStrengthDays, estimateRetention, decayConfidence } from "../../src/core/decay.js";
import { makeBelief } from "./fixtures.js";

describe("decay", () => {
  it("confidence 0.775 after 5 days → 0.665", () => {
    expect(decayConfidence(0.775, 5)).toBeCloseTo(0.665, 2);
  });

  it("retention: mu 0.5813, conf 0.775, 5 days → 0.321", () => {
    expect(estimateRetention(0.5813, 0.775, 5)).toBeCloseTo(0.321, 3);
  });

  it("strength scales with both mu and confidence", () => {
    const base = computeStrengthDays(0.5, 0.5);
    const higherMu = computeStrengthDays(0.9, 0.5);
    const higherConfidence = computeStrengthDays(0.5, 0.9);
    expect(higherMu).toBeGreaterThan(base);
    expect(higherConfidence).toBeGreaterThan(base);
  });

  it("retention at t=0 equals mu exactly", () => {
    expect(estimateRetention(0.63, 0.4, 0)).toBe(0.63);
  });

  it("applyDecay reproduces the §5 worked example", () => {
    const lastObservedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-06T00:00:00Z"); // +5 days
    const belief = makeBelief({ mu: 0.5813, confidence: 0.775, last_observed_at: lastObservedAt });

    const decayed = applyDecay(belief, now);

    expect(decayed.strength_days).toBeCloseTo(8.41, 1);
    expect(decayed.retention_estimate).toBeCloseTo(0.321, 3);
    expect(decayed.confidence).toBeCloseTo(0.665, 2);
    expect(decayed.mu).toBe(0.5813); // decay never touches mu
  });

  it("applyDecay is a no-op with no prior observation", () => {
    const belief = makeBelief({ last_observed_at: null });
    expect(applyDecay(belief, new Date())).toBe(belief);
  });
});
