import { describe, it, expect } from "vitest";
import { scheduleAfterImmediateTest, scheduleAfterRecall, checkPreemptiveRecall } from "../../src/core/recall.js";

describe("active recall scheduler", () => {
  it("after IMMEDIATE_TEST → proposals at +3d and +10d", () => {
    const testAt = new Date("2026-01-01T00:00:00Z");
    const proposals = scheduleAfterImmediateTest("arr_traversal", testAt);

    expect(proposals).toHaveLength(2);
    expect(proposals[0].due_at.toISOString()).toBe(new Date("2026-01-04T00:00:00Z").toISOString());
    expect(proposals[1].due_at.toISOString()).toBe(new Date("2026-01-11T00:00:00Z").toISOString());
    expect(proposals.every((p) => p.reason === "scheduled_interval")).toBe(true);
  });

  it("recall 0.90 → next interval doubles, capped at 21d", () => {
    const recallAt = new Date("2026-01-01T00:00:00Z");
    const [next] = scheduleAfterRecall("arr_traversal", recallAt, 0.9, 3, 0);
    expect(next.due_at.toISOString()).toBe(new Date("2026-01-07T00:00:00Z").toISOString()); // +6d

    const [capped] = scheduleAfterRecall("arr_traversal", recallAt, 0.9, 15, 1);
    expect(capped.due_at.toISOString()).toBe(new Date("2026-01-22T00:00:00Z").toISOString()); // capped at +21d, not +30d
  });

  it("recall 0.40 → interval × 0.4 AND a REVISION proposal emitted", () => {
    const recallAt = new Date("2026-01-01T00:00:00Z");
    const proposals = scheduleAfterRecall("arr_traversal", recallAt, 0.4, 10, 1);

    expect(proposals).toHaveLength(2);
    const scheduled = proposals.find((p) => p.reason === "scheduled_interval")!;
    const failure = proposals.find((p) => p.reason === "recall_failure")!;

    expect(scheduled.due_at.toISOString()).toBe(new Date("2026-01-05T00:00:00Z").toISOString()); // +4d
    expect(failure.due_at.getTime()).toBe(recallAt.getTime());
  });

  it("★ retention below target × 0.8 → pre-emptive proposal with reason 'retention_decay', with no failure event present", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const proposal = checkPreemptiveRecall(
      { subtopic_id: "arr_traversal", retention_estimate: 0.5, target_mastery: 0.75, blueprint_weight: 0.2 },
      now,
    );

    expect(proposal).not.toBeNull();
    expect(proposal!.reason).toBe("retention_decay");
    // no failure/event object anywhere in the input that produced this — it's a pure forecast
  });

  it("subtopics with blueprint_weight < 0.05 never trigger pre-emptive recall", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const proposal = checkPreemptiveRecall(
      { subtopic_id: "arr_traversal", retention_estimate: 0.1, target_mastery: 0.75, blueprint_weight: 0.01 },
      now,
    );
    expect(proposal).toBeNull();
  });

  it("retention above the trigger ratio does not fire", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const proposal = checkPreemptiveRecall(
      { subtopic_id: "arr_traversal", retention_estimate: 0.7, target_mastery: 0.75, blueprint_weight: 0.2 },
      now,
    );
    expect(proposal).toBeNull();
  });
});
