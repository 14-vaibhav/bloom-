import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { students, toolHealth, agentRuns } from "../../src/db/schema.js";
import { createSeqCounter, type AgentContext } from "../../src/tools/context.js";
import type { Clock } from "../../src/lib/clock.js";

export async function getDemoStudentId(): Promise<string> {
  // Filter by email, not `limit(1)` with no order — the eval harness persists synthetic
  // students into this same table, so an unfiltered query is nondeterministic once any
  // eval run has happened against this database.
  const [row] = await db.select({ id: students.id }).from(students).where(eq(students.email, "demo@bloom.local"));
  if (!row) throw new Error("No seeded demo student found — run `npm run seed` first.");
  return row.id;
}

export async function resetToolHealth(tool?: string): Promise<void> {
  if (tool) {
    await db
      .update(toolHealth)
      .set({ state: "closed", consecutiveFailures: 0, openedAt: null, lastError: null })
      .where(eq(toolHealth.toolName, tool));
  } else {
    await db.update(toolHealth).set({ state: "closed", consecutiveFailures: 0, openedAt: null, lastError: null });
  }
}

export function fakeClock(startMs: number): Clock & { advance: (ms: number) => void } {
  let now = startMs;
  const clock = (() => new Date(now)) as Clock & { advance: (ms: number) => void };
  clock.advance = (ms: number) => { now += ms; };
  return clock;
}

export async function makeContext(studentId: string, clock?: Clock): Promise<AgentContext> {
  const [run] = await db
    .insert(agentRuns)
    .values({ studentId, trigger: "TEST", scope: "PATCH" })
    .returning({ id: agentRuns.id });
  return {
    runId: run.id,
    studentId,
    phase: "retrieve",
    clock: clock ?? (() => new Date()),
    nextSeq: createSeqCounter(),
  };
}
