import { describe, it, expect } from "vitest";
import { rankResources, scoreResourceFit } from "../../src/core/resourceFit.js";
import type { FormatEfficacy, ResourceCandidate } from "../../src/core/types.js";

function candidate(overrides: Partial<ResourceCandidate> & { id: string }): ResourceCandidate {
  return {
    type: "article",
    difficulty: 3,
    duration_min: 30,
    quality: 0.8,
    blacklisted: false,
    already_consumed: false,
    covers_focus_concept: false,
    ...overrides,
  };
}

const FORMAT_EFFICACY: FormatEfficacy = { video: 0.04, article: 0.11, practice: 0.19, doc: 0.10, course: 0.10 };

describe("resource fit — bloom-phase4-brief §5.2 worked example (45-min slot, mu=0.45)", () => {
  const mu = 0.45;
  const slotMinutes = 45;

  it("Binary Search Full Course (video, diff 3, 95 min) -> 0.595", () => {
    const c = candidate({ id: "full_course", type: "video", difficulty: 3, duration_min: 95, quality: 0.92 });
    const scored = scoreResourceFit(c, mu, slotMinutes, FORMAT_EFFICACY);
    expect(scored.breakdown.level_match).toBeCloseTo(1.0, 4);
    expect(scored.breakdown.duration_fit).toBe(0);
    expect(scored.fit).toBeCloseTo(0.595, 3);
  });

  it("Binary Search Patterns (article, diff 3, 30 min) -> 0.839", () => {
    const c = candidate({ id: "patterns", type: "article", difficulty: 3, duration_min: 30, quality: 0.85 });
    const scored = scoreResourceFit(c, mu, slotMinutes, FORMAT_EFFICACY);
    expect(scored.fit).toBeCloseTo(0.839, 3);
  });

  it("Off-by-one drills (practice, diff 3, 40 min, on-concept) -> 0.982, the top pick", () => {
    const c = candidate({ id: "drills", type: "practice", difficulty: 3, duration_min: 40, quality: 0.88, covers_focus_concept: true });
    const scored = scoreResourceFit(c, mu, slotMinutes, FORMAT_EFFICACY);
    expect(scored.fit).toBeCloseTo(0.982, 3);
  });

  it("Intro to Binary Search (video, diff 1, 20 min, already consumed) -> 0.597", () => {
    const c = candidate({ id: "intro", type: "video", difficulty: 1, duration_min: 20, quality: 0.80, already_consumed: true });
    const scored = scoreResourceFit(c, mu, slotMinutes, FORMAT_EFFICACY);
    expect(scored.breakdown.level_match).toBeCloseTo(0.6, 4);
    expect(scored.breakdown.novelty).toBeCloseTo(0.2, 4);
    expect(scored.fit).toBeCloseTo(0.597, 3);
  });

  it("ranks the drill set first among all four candidates", () => {
    const candidates = [
      candidate({ id: "full_course", type: "video", difficulty: 3, duration_min: 95, quality: 0.92 }),
      candidate({ id: "patterns", type: "article", difficulty: 3, duration_min: 30, quality: 0.85 }),
      candidate({ id: "drills", type: "practice", difficulty: 3, duration_min: 40, quality: 0.88, covers_focus_concept: true }),
      candidate({ id: "intro", type: "video", difficulty: 1, duration_min: 20, quality: 0.80, already_consumed: true }),
    ];
    const ranked = rankResources(candidates, mu, slotMinutes, FORMAT_EFFICACY, 3);
    expect(ranked).toHaveLength(3);
    expect(ranked[0].resource_id).toBe("drills");
    expect(ranked[0].fit).toBeGreaterThan(ranked[1].fit);
  });
});

describe("resource fit — edge cases", () => {
  it("a resource far longer than the slot has duration_fit exactly 0", () => {
    const c = candidate({ id: "long", duration_min: 95 });
    const scored = scoreResourceFit(c, 0.5, 45, FORMAT_EFFICACY);
    expect(scored.breakdown.duration_fit).toBe(0);
  });

  it("when every format_efficacy is at the default, format_match is 1.0 for every candidate", () => {
    const defaultEfficacy: FormatEfficacy = { video: 0.10, article: 0.10, practice: 0.10, doc: 0.10, course: 0.10 };
    for (const type of ["video", "article", "practice", "doc", "course"] as const) {
      const scored = scoreResourceFit(candidate({ id: type, type }), 0.5, 45, defaultEfficacy);
      expect(scored.breakdown.format_match).toBeCloseTo(1.0, 5);
    }
  });

  it("a blacklisted resource has novelty exactly 0", () => {
    const scored = scoreResourceFit(candidate({ id: "dead", blacklisted: true }), 0.5, 45, FORMAT_EFFICACY);
    expect(scored.breakdown.novelty).toBe(0);
  });

  it("fit stays within [0,1] for extreme inputs", () => {
    const c = candidate({ id: "extreme", difficulty: 5, duration_min: 1000, quality: 1, blacklisted: true });
    const scored = scoreResourceFit(c, 0, 5, FORMAT_EFFICACY);
    expect(scored.fit).toBeGreaterThanOrEqual(0);
    expect(scored.fit).toBeLessThanOrEqual(1);
  });
});
