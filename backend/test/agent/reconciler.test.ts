import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { agentEvents, agentRuns, students } from "../../src/db/schema.js";
import { reconcileOnStartup } from "../../src/agent/reconciler.js";

let studentId: string;
let runId: string;

beforeAll(async () => {
  const [student] = await db
    .insert(students)
    .values({
      name: "Reconciler Test Student",
      email: `reconciler-${crypto.randomUUID()}@bloom.test`,
      simNow: new Date("2026-11-01T08:00:00Z"),
    })
    .returning({ id: students.id });
  studentId = student.id;

  const [run] = await db
    .insert(agentRuns)
    .values({ studentId, trigger: "INITIAL_GOAL", scope: "FULL", lastCompletedPhase: 6 })
    .returning({ id: agentRuns.id });
  runId = run.id;
});

afterAll(async () => {
  await db.delete(agentRuns).where(eq(agentRuns.id, runId));
  await db.delete(students).where(eq(students.id, studentId));
});

describe("reconcileOnStartup", () => {
  it("abandons an interrupted pre-commit run and records an audit event", async () => {
    const summary = await reconcileOnStartup();
    expect(summary.abandoned).toBeGreaterThanOrEqual(1);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.status).toBe("abandoned");
    expect(run.endedAt).not.toBeNull();

    const events = await db.select().from(agentEvents).where(eq(agentEvents.runId, runId));
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("abandoned at phase 6");
  });
});
