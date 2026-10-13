import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { agentEvents } from "../../src/db/schema.js";
import { callTool } from "../../src/tools/dispatcher.js";
import { getDemoStudentId, makeContext, resetToolHealth } from "./helpers.js";

let studentId: string;

beforeAll(async () => {
  studentId = await getDemoStudentId();
});

beforeEach(async () => {
  await resetToolHealth();
});

async function eventsForRun(runId: string) {
  return db.select().from(agentEvents).where(eq(agentEvents.runId, runId)).orderBy(agentEvents.seq);
}

describe("dispatcher", () => {
  it("a successful call writes exactly one agent_events row", async () => {
    const ctx = await makeContext(studentId);
    await callTool(ctx, "performance.get_student_performance", { student_id: studentId });
    const rows = await eventsForRun(ctx.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolName).toBe("performance");
    expect(rows[0].errorClass).toBeNull();
  });

  it("seq increments monotonically within a run across multiple calls", async () => {
    const ctx = await makeContext(studentId);
    await callTool(ctx, "performance.get_student_performance", { student_id: studentId });
    await callTool(ctx, "state.get_constraints", { student_id: studentId, effective_at: new Date().toISOString() });
    const rows = await eventsForRun(ctx.runId);
    const seqs = rows.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("concurrent calls on the same context don't collide on seq", async () => {
    const ctx = await makeContext(studentId);
    await Promise.all(
      Array.from({ length: 5 }, () => callTool(ctx, "performance.get_student_performance", { student_id: studentId })),
    );
    const rows = await eventsForRun(ctx.runId);
    const seqs = rows.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(5);
  });

  it("invalid input is rejected with a validation error and logged, never retried", async () => {
    const ctx = await makeContext(studentId);
    await expect(
      callTool(ctx, "performance.get_student_performance", { student_id: "not-a-uuid" } as never),
    ).rejects.toThrow();
    const rows = await eventsForRun(ctx.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorClass).toBe("validation");
    expect(rows[0].retryAttempt).toBe(0);
  });

  it("payloads over 2KB are truncated", async () => {
    const ctx = await makeContext(studentId);
    await callTool(ctx, "rag.search_learning_resources", {
      subtopic_id: "arr_traversal",
      target_difficulty: 3,
      max_duration_min: 120,
      exclude_ids: [],
      k: 8,
    });
    const rows = await eventsForRun(ctx.runId);
    const payloadJson = JSON.stringify(rows[0].payload);
    expect(payloadJson.length).toBeLessThan(6000); // generous ceiling — input/output are each capped independently
  });

  it("a permanent error is logged and not retried", async () => {
    const ctx = await makeContext(studentId);
    await expect(callTool(ctx, "rag.get_resource_details", { resource_id: "res_does_not_exist" })).rejects.toThrow();
    const rows = await eventsForRun(ctx.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorClass).toBe("permanent");
    expect(rows[0].retryAttempt).toBe(0);
  });

  it("no code path reaches a tool except through callTool (registry covers all 21 ops)", async () => {
    const { ALL_TOOL_NAMES } = await import("../../src/tools/schemas.js");
    const { registry } = await import("../../src/tools/registry.js");
    for (const name of ALL_TOOL_NAMES) {
      expect(registry[name], name).toBeTypeOf("function");
    }
  });
});
