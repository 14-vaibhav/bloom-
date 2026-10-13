import { describe, expect, it } from "vitest";
import { computePlanDiff, type DiffAfterActivity, type DiffBeforeActivity } from "../../src/agent/diff.js";

function before(overrides: Partial<DiffBeforeActivity> = {}): DiffBeforeActivity {
  return {
    activity_id: "a1",
    subtopic_id: "arr_traversal",
    action: "LEARN",
    start: "2026-11-10T18:00:00.000Z",
    end: "2026-11-10T18:45:00.000Z",
    resource_id: "res_1",
    duration_min: 45,
    ...overrides,
  };
}

function after(overrides: Partial<DiffAfterActivity> = {}): DiffAfterActivity {
  return { ...before(), carried_from_activity_id: "a1", ...overrides };
}

describe("computePlanDiff", () => {
  it("an untouched activity is unchanged, not added+removed", () => {
    const diff = computePlanDiff([before()], [after()]);
    expect(diff.unchanged_count).toBe(1);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.moved).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("a different start/end is moved, not added+removed", () => {
    const diff = computePlanDiff([before()], [after({ start: "2026-11-11T18:00:00.000Z", end: "2026-11-11T18:45:00.000Z" })]);
    expect(diff.moved).toHaveLength(1);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged_count).toBe(0);
  });

  it("a swapped resource with the same slot is modified", () => {
    const diff = computePlanDiff([before()], [after({ resource_id: "res_2" })]);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].field).toBe("resource_id");
    expect(diff.modified[0].from).toBe("res_1");
    expect(diff.modified[0].to).toBe("res_2");
  });

  it("a changed duration with the same start is modified", () => {
    const diff = computePlanDiff([before()], [after({ duration_min: 30 })]);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].field).toBe("duration_min");
  });

  it("an activity with no carried_from_activity_id is added", () => {
    const diff = computePlanDiff([], [after({ activity_id: "new:x", carried_from_activity_id: null })]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
  });

  it("a before-activity with no counterpart in after is removed", () => {
    const diff = computePlanDiff([before()], []);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added).toHaveLength(0);
  });

  it("a lineage id that no longer matches any before-activity is treated as added, not crashed on", () => {
    const diff = computePlanDiff([before()], [after({ carried_from_activity_id: "does-not-exist" })]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1); // the untouched original now has no counterpart
  });

  it("a realistic PATCH: one moved, the rest unchanged", () => {
    const beforeSet: DiffBeforeActivity[] = Array.from({ length: 21 }, (_, i) => before({ activity_id: `a${i}`, subtopic_id: `s${i}` }));
    const afterSet: DiffAfterActivity[] = beforeSet.map((b, i) =>
      i === 0 ? after({ ...b, carried_from_activity_id: b.activity_id, start: "2026-11-12T18:00:00.000Z", end: "2026-11-12T18:45:00.000Z" }) : after({ ...b, carried_from_activity_id: b.activity_id }),
    );
    const diff = computePlanDiff(beforeSet, afterSet);
    expect(diff.moved).toHaveLength(1);
    expect(diff.unchanged_count).toBe(20);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});
