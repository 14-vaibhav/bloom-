import { describe, expect, it } from "vitest";
import { deferActivities, insertActivity, rescheduleActivity, swapResource, type PatchActivity } from "../../src/agent/patchOps.js";
import type { Slot } from "../../src/core/types.js";

function activity(overrides: Partial<PatchActivity> = {}): PatchActivity {
  return {
    id: "a1",
    subtopic_id: "arr_traversal",
    resource_id: "res_1",
    action: "LEARN",
    start: new Date("2026-11-10T18:00:00Z"),
    end: new Date("2026-11-10T18:45:00Z"),
    duration_min: 45,
    priority: 50,
    predicted_score: 0.5,
    expected_mastery_after: 0.5,
    provisional: false,
    ...overrides,
  };
}

function slot(startIso: string, durationMin = 60): Slot {
  const start = new Date(startIso);
  return { start, end: new Date(start.getTime() + durationMin * 60000), duration_min: durationMin, energy_weight: 1 };
}

describe("rescheduleActivity", () => {
  it("moves the target to the earliest non-conflicting slot at/after notBefore", () => {
    const a = activity();
    const others = [activity({ id: "a2", start: new Date("2026-11-11T18:00:00Z"), end: new Date("2026-11-11T18:30:00Z") })];
    const slots = [slot("2026-11-11T18:00:00Z", 45), slot("2026-11-12T18:00:00Z", 45)];
    const result = rescheduleActivity([a, ...others], slots, { activityId: "a1", notBefore: new Date("2026-11-11T00:00:00Z") });
    expect(result.touched).toEqual(["a1"]);
    const moved = result.activities.find((x) => x.id === "a1")!;
    expect(moved.start.toISOString()).toBe(new Date("2026-11-12T18:00:00Z").toISOString());
  });

  it("leaves the plan untouched when no compatible slot exists", () => {
    const a = activity();
    const result = rescheduleActivity([a], [], { activityId: "a1", notBefore: new Date("2026-11-11T00:00:00Z") });
    expect(result.touched).toHaveLength(0);
    expect(result.activities).toEqual([a]);
  });

  it("no-ops when the activity id doesn't exist", () => {
    const result = rescheduleActivity([activity()], [slot("2026-11-11T18:00:00Z")], { activityId: "missing", notBefore: new Date() });
    expect(result.touched).toHaveLength(0);
  });
});

describe("insertActivity", () => {
  it("inserts a brand-new activity with a synthetic id into a free slot", () => {
    const result = insertActivity([activity()], [slot("2026-11-11T18:00:00Z", 15)], {
      subtopic_id: "tr_bst", action: "ACTIVE_RECALL", duration_min: 15, notBefore: new Date("2026-11-11T00:00:00Z"), predicted_score: 0.7, expected_mastery_after: 0.7,
    });
    expect(result.inserted).toBe(1);
    expect(result.activities).toHaveLength(2);
    const created = result.activities.find((a) => a.subtopic_id === "tr_bst")!;
    expect(created.id.startsWith("new:")).toBe(true);
    expect(created.action).toBe("ACTIVE_RECALL");
  });

  it("does not insert when no slot is long enough", () => {
    const result = insertActivity([], [slot("2026-11-11T18:00:00Z", 10)], {
      subtopic_id: "tr_bst", action: "ACTIVE_RECALL", duration_min: 15, notBefore: new Date("2026-11-11T00:00:00Z"), predicted_score: 0.7, expected_mastery_after: 0.7,
    });
    expect(result.inserted).toBe(0);
  });
});

describe("swapResource", () => {
  it("replaces the resource and keeps the slot", () => {
    const a = activity();
    const result = swapResource([a], { activityId: "a1", newResourceId: "res_2" });
    expect(result.touched).toEqual(["a1"]);
    const swapped = result.activities[0];
    expect(swapped.resource_id).toBe("res_2");
    expect(swapped.start).toEqual(a.start);
  });

  it("clears the provisional flag when asked", () => {
    const a = activity({ provisional: true });
    const result = swapResource([a], { activityId: "a1", newResourceId: "res_2", clearProvisional: true });
    expect(result.activities[0].provisional).toBe(false);
  });
});

describe("deferActivities", () => {
  it("pushes only the named ids forward by N days, leaving the rest untouched", () => {
    const a = activity({ id: "a1" });
    const b = activity({ id: "a2", start: new Date("2026-11-10T19:00:00Z"), end: new Date("2026-11-10T19:45:00Z") });
    const result = deferActivities([a, b], { activityIds: ["a1"], days: 1 });
    expect(result.touched).toEqual(["a1"]);
    const deferred = result.activities.find((x) => x.id === "a1")!;
    expect(deferred.start.toISOString()).toBe(new Date("2026-11-11T18:00:00Z").toISOString());
    const untouched = result.activities.find((x) => x.id === "a2")!;
    expect(untouched.start).toEqual(b.start);
  });

  it("caps the deferred set at 5 activities", () => {
    const activities = Array.from({ length: 6 }, (_, i) => activity({ id: `a${i}` }));
    const result = deferActivities(activities, { activityIds: activities.map((a) => a.id), days: 1 });
    expect(result.touched).toHaveLength(5);
  });
});
