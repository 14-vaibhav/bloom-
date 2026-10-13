import { describe, expect, it } from "vitest";
import { computeStatus, computePrimaryCause, type Signals } from "../../src/agent/summary.js";

function signals(overrides: Partial<Signals> = {}): Signals {
  return { attendance14d: 0.9, trajectory: 1.0, bufferDays: 5, requiredHours: 10, availableHours: 20, ...overrides };
}

describe("computeStatus", () => {
  it("buffer >= 3d and attendance >= 0.7 is ON_TRACK", () => {
    expect(computeStatus(signals({ bufferDays: 5, attendance14d: 0.86 }))).toBe("ON_TRACK");
  });

  it("buffer between 0 and 3 days is AT_RISK", () => {
    expect(computeStatus(signals({ bufferDays: 1.5 }))).toBe("AT_RISK");
  });

  it("trajectory below 0.7 is AT_RISK even with a healthy buffer", () => {
    expect(computeStatus(signals({ bufferDays: 5, trajectory: 0.5 }))).toBe("AT_RISK");
  });

  it("attendance below 0.7 is AT_RISK even with a healthy buffer", () => {
    expect(computeStatus(signals({ bufferDays: 5, attendance14d: 0.5 }))).toBe("AT_RISK");
  });

  it("negative buffer is BEHIND", () => {
    expect(computeStatus(signals({ bufferDays: -8 }))).toBe("BEHIND");
  });

  it("required hours exceeding available hours is INFEASIBLE regardless of buffer", () => {
    expect(computeStatus(signals({ bufferDays: 5, requiredHours: 40, availableHours: 20 }))).toBe("INFEASIBLE");
  });

  it("null attendance/trajectory (no data yet) does not block ON_TRACK", () => {
    expect(computeStatus(signals({ attendance14d: null, trajectory: null, bufferDays: 5 }))).toBe("ON_TRACK");
  });
});

describe("computePrimaryCause", () => {
  it("identifies the subtopic with the largest hours overrun", () => {
    const cause = computePrimaryCause(
      [
        { subtopic_id: "tr_traversal", actual_hours: 4.8, predicted_hours: 2.0 },
        { subtopic_id: "arr_two_pointer", actual_hours: 1.2, predicted_hours: 1.0 },
      ],
      0,
    );
    expect(cause?.subtopic_id).toBe("tr_traversal");
    expect(cause?.kind).toBe("time_overrun");
    expect(cause?.detail).toContain("2.4x");
  });

  it("falls back to missed time when it dominates any single overrun", () => {
    const cause = computePrimaryCause([{ subtopic_id: "tr_traversal", actual_hours: 2.1, predicted_hours: 2.0 }], 5);
    expect(cause?.kind).toBe("missed_time");
  });

  it("returns null when there is nothing to explain", () => {
    expect(computePrimaryCause([], 0)).toBeNull();
  });
});
