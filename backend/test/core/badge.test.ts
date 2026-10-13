import { describe, it, expect } from "vitest";
import { computeMasteryBadge } from "../../src/core/badge.js";
import { makeBelief } from "./fixtures.js";

describe("mastery badge", () => {
  it("all four conditions met → green", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    const belief = makeBelief({
      mu: 0.8,
      confidence: 0.75,
      last_observed_at: new Date("2026-01-05T00:00:00Z"), // 5 days ago
    });

    const result = computeMasteryBadge(belief, 0.75, now, {
      assessment_count: 3,
      had_assessment_at_or_above_target_difficulty: true,
    });

    expect(result.level).toBe("green");
    expect(result.reasons).toHaveLength(0);
  });

  it("mu high, one assessment only → amber with the right reason string", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    const belief = makeBelief({
      mu: 0.8,
      confidence: 0.75,
      last_observed_at: new Date("2026-01-05T00:00:00Z"),
    });

    const result = computeMasteryBadge(belief, 0.75, now, {
      assessment_count: 1,
      had_assessment_at_or_above_target_difficulty: true,
    });

    expect(result.level).toBe("amber");
    expect(result.reasons.some((r) => r.includes("1 assessment"))).toBe(true);
  });

  it("green badge + 20 days of decay + no input → amber", () => {
    const now = new Date("2026-01-25T00:00:00Z"); // 20 days after the observation
    const belief = makeBelief({
      mu: 0.8,
      confidence: 0.75,
      last_observed_at: new Date("2026-01-05T00:00:00Z"),
    });
    const context = { assessment_count: 3, had_assessment_at_or_above_target_difficulty: true };

    const fresh = computeMasteryBadge(belief, 0.75, new Date("2026-01-05T00:00:00Z"), context);
    const stale = computeMasteryBadge(belief, 0.75, now, context);

    expect(fresh.level).toBe("green");
    expect(stale.level).toBe("amber");
    expect(stale.reasons.some((r) => r.includes("days ago"))).toBe(true);
  });

  it("mu below target → grey regardless of everything else", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    const belief = makeBelief({ mu: 0.5, confidence: 0.9, last_observed_at: now });
    const result = computeMasteryBadge(belief, 0.75, now, {
      assessment_count: 5,
      had_assessment_at_or_above_target_difficulty: true,
    });
    expect(result.level).toBe("grey");
  });
});
