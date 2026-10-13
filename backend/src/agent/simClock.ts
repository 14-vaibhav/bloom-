/**
 * The simulated clock (bloom-phase6-brief §3). `sim_now` lives on `students`,
 * per student, so the eval harness can run many students at different
 * simulated dates concurrently.
 *
 * Nothing in the orchestrator calls `new Date()` for a domain decision — every
 * domain decision reads sim_now via getSimNow() or the value threaded through
 * an AgentContext.clock() built from it. The one exception is real-world audit
 * timestamps (agentEvents/agentRuns.createdAt defaults), which are allowed to
 * use the DB's own now() — those record when Bloom's process did something,
 * not when the simulated student experienced it.
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { learningActivities, students, studyPlans } from "../db/schema.js";
import { PermanentError } from "../tools/errors.js";

export async function getSimNow(studentId: string): Promise<Date> {
  const [row] = await db.select({ simNow: students.simNow }).from(students).where(eq(students.id, studentId));
  if (!row) throw new PermanentError(`Student ${studentId} not found`);
  return row.simNow;
}

export type AdvanceResult = { from: Date; to: Date; hours: number };

export async function advanceSimClock(studentId: string, hours: number): Promise<AdvanceResult> {
  if (hours <= 0) throw new PermanentError(`advanceSimClock: hours must be positive, got ${hours}`);
  const from = await getSimNow(studentId);
  const to = new Date(from.getTime() + hours * 3_600_000);
  await db.update(students).set({ simNow: to }).where(eq(students.id, studentId));
  return { from, to, hours };
}

export type MissedActivity = { id: string; subtopicId: string; action: string; scheduledEnd: Date };

/**
 * Marks every still-`planned` activity in the CURRENT plan version whose
 * scheduled_end has passed as `missed` (§3, "clock-driven miss detection").
 * Idempotent by construction (the `status = 'planned'` predicate), and scoped
 * to the current plan version only — activities from a superseded version are
 * historical and must never contaminate the attendance ratio.
 */
export async function markMissedActivities(studentId: string, now: Date): Promise<MissedActivity[]> {
  const [plan] = await db.select({ id: studyPlans.id, currentVersion: studyPlans.currentVersion }).from(studyPlans).where(eq(studyPlans.studentId, studentId));
  if (!plan) return [];

  const rows = await db.query.learningActivities.findMany({
    where: (a, { and, eq, lt }) =>
      and(eq(a.studentId, studentId), eq(a.planId, plan.id), eq(a.planVersion, plan.currentVersion), eq(a.status, "planned"), lt(a.scheduledEnd, now)),
  });
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  await db
    .update(learningActivities)
    .set({ status: "missed", missedAt: now })
    .where(inArray(learningActivities.id, ids));

  return rows.map((r) => ({ id: r.id, subtopicId: r.subtopicId, action: r.action, scheduledEnd: r.scheduledEnd }));
}
