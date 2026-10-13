import { describe, it, expect } from "vitest";
import { generateSlots } from "../../src/core/slotter.js";
import { overlaps } from "../../src/lib/time.js";
import type { StudentConstraintsInput, WeeklyAvailability } from "../../src/core/types.js";

function allDaysWindow(start: string, end: string): WeeklyAvailability {
  const window = [{ start, end }];
  return { "0": window, "1": window, "2": window, "3": window, "4": window, "5": window, "6": window };
}

function constraints(overrides: Partial<StudentConstraintsInput> = {}): StudentConstraintsInput {
  return {
    weekly_availability: allDaysWindow("09:00", "12:00"),
    max_daily_study_min: 300,
    min_session_min: 15,
    max_session_min: 90,
    blackout_dates: [],
    ...overrides,
  };
}

const DAY_FROM = new Date("2026-11-02T00:00:00Z");
const DAY_TO = new Date("2026-11-02T23:59:00Z");

describe("slotter — bloom-phase4-brief §6", () => {
  it("a busy event fully inside a window splits it into two slots", () => {
    const busy = [{ start: new Date("2026-11-02T10:00:00Z"), end: new Date("2026-11-02T11:00:00Z") }];
    const slots = generateSlots(constraints(), busy, DAY_FROM, DAY_TO, {});
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ duration_min: 60 });
    expect(slots[1]).toMatchObject({ duration_min: 60 });
    expect(slots[0].start.toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(slots[0].end.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(slots[1].start.toISOString()).toBe("2026-11-02T11:00:00.000Z");
    expect(slots[1].end.toISOString()).toBe("2026-11-02T12:00:00.000Z");
  });

  it("a busy event partially overlapping the window truncates correctly", () => {
    const busy = [{ start: new Date("2026-11-02T08:00:00Z"), end: new Date("2026-11-02T10:00:00Z") }];
    const slots = generateSlots(constraints({ max_session_min: 180 }), busy, DAY_FROM, DAY_TO, {});
    expect(slots).toHaveLength(1);
    expect(slots[0].start.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(slots[0].end.toISOString()).toBe("2026-11-02T12:00:00.000Z");
    expect(slots[0].duration_min).toBe(120);
  });

  it("drops a fragment shorter than min_session_min", () => {
    const slots = generateSlots(
      constraints({ weekly_availability: allDaysWindow("09:00", "09:10"), min_session_min: 15 }),
      [],
      DAY_FROM,
      DAY_TO,
      {},
    );
    expect(slots).toHaveLength(0);
  });

  it("a 3-hour window with max_session 90 produces two slots plus a gap", () => {
    const slots = generateSlots(constraints({ min_session_min: 15, max_session_min: 90 }), [], DAY_FROM, DAY_TO, {});
    expect(slots).toHaveLength(2);
    expect(slots[0].duration_min).toBe(90);
    expect(slots[0].end.toISOString()).toBe("2026-11-02T10:30:00.000Z");
    expect(slots[1].start.toISOString()).toBe("2026-11-02T10:40:00.000Z"); // 10-minute gap after the split
    expect(slots[1].duration_min).toBe(80);
  });

  it("a blackout date produces zero slots", () => {
    const slots = generateSlots(constraints({ blackout_dates: ["2026-11-02"] }), [], DAY_FROM, DAY_TO, {});
    expect(slots).toHaveLength(0);
  });

  it("the daily cap trims from the end of the day", () => {
    const slots = generateSlots(
      constraints({ weekly_availability: allDaysWindow("09:00", "13:00"), max_daily_study_min: 150, min_session_min: 15, max_session_min: 90 }),
      [],
      DAY_FROM,
      DAY_TO,
      {},
    );
    const total = slots.reduce((sum, s) => sum + s.duration_min, 0);
    expect(total).toBe(150);
    expect(slots).toHaveLength(2);
    expect(slots[0].duration_min).toBe(90);
    expect(slots[1].duration_min).toBe(60); // truncated from its natural 90
    expect(slots[1].end.toISOString()).toBe("2026-11-02T11:40:00.000Z");
  });

  it("the shared overlap convention treats touching endpoints as non-overlapping — half-open intervals", () => {
    // This is the one convention slotter.ts and (later) the validator must never disagree
    // on. Guard it directly: flipping either `<` to `<=` in lib/time.ts's overlaps()
    // must fail this test.
    const a = { start: new Date("2026-11-02T18:00:00Z"), end: new Date("2026-11-02T19:00:00Z") };
    const b = { start: new Date("2026-11-02T19:00:00Z"), end: new Date("2026-11-02T20:00:00Z") };
    expect(overlaps(a.start, a.end, b.start, b.end)).toBe(false);
    expect(overlaps(b.start, b.end, a.start, a.end)).toBe(false);
  });

  it("a slot ending at 19:00 and one starting at 19:00 do not overlap — half-open intervals", () => {
    const window = allDaysWindow("18:00", "20:00");
    const busyEndingAt19 = [{ start: new Date("2026-11-02T18:00:00Z"), end: new Date("2026-11-02T19:00:00Z") }];
    const slots = generateSlots(constraints({ weekly_availability: window }), busyEndingAt19, DAY_FROM, DAY_TO, {});
    expect(slots).toHaveLength(1);
    expect(slots[0].start.toISOString()).toBe("2026-11-02T19:00:00.000Z");
    expect(slots[0].end.toISOString()).toBe("2026-11-02T20:00:00.000Z");
  });

  it("a range spanning a DST-transition-like date loses no day and duplicates none", () => {
    const from = new Date("2026-03-07T00:00:00Z");
    const to = new Date("2026-03-09T23:59:00Z");
    const slots = generateSlots(constraints(), [], from, to, {});
    const days = new Set(slots.map((s) => s.start.toISOString().slice(0, 10)));
    expect(days.size).toBe(3);
    expect([...days].sort()).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
  });

  it("energy_weight falls back to 1.0 when the hour has no completion data", () => {
    const slots = generateSlots(constraints(), [], DAY_FROM, DAY_TO, {});
    expect(slots.every((s) => s.energy_weight === 1.0)).toBe(true);
  });

  it("energy_weight is read from completionByHour when present", () => {
    const slots = generateSlots(constraints({ max_session_min: 180 }), [], DAY_FROM, DAY_TO, { 9: 0.42 });
    expect(slots[0].energy_weight).toBe(0.42);
  });
});
