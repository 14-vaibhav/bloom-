/**
 * Startup reconciler (bloom-phase6-brief §9, §12). Runs once when the backend
 * boots, before the tick loop starts. Tractable only because phases 1-9 write
 * nothing but agent_events and idempotent beliefs (§2) — a run stuck before
 * phase 10 is guaranteed to have made no plan/activity/calendar changes, so
 * "abandon it" is always safe.
 *
 * Phase 10 itself (state.save_plan_version) flips agent_runs.status to
 * 'completed' inside the SAME transaction as the plan insert, so in practice
 * a run can only be found 'running' with last_completed_phase >= 10 if the
 * process died in the narrow window between that transaction landing and the
 * orchestrator's own bookkeeping catching up — the "verify, don't assume"
 * branch below exists for exactly that gap.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentEvents, agentRuns, planVersions, studyPlans, toolHealth } from "../db/schema.js";
import { OPEN_DURATION_MS } from "../tools/breaker.js";

async function appendNotice(runId: string, studentId: string, phase: (typeof agentEvents.$inferInsert)["phase"], message: string): Promise<void> {
  const rows = await db.query.agentEvents.findMany({ where: (e, { eq }) => eq(e.runId, runId) });
  const nextSeq = rows.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
  await db.insert(agentEvents).values({ runId, studentId, seq: nextSeq, phase, eventType: "notice", message });
}

export type ReconcileSummary = { abandoned: number; completed: number; failed: number; halfOpened: string[] };

export async function reconcileOnStartup(): Promise<ReconcileSummary> {
  const stuck = await db.query.agentRuns.findMany({ where: (r, { eq }) => eq(r.status, "running") });
  let abandoned = 0;
  let completed = 0;
  let failed = 0;

  for (const run of stuck) {
    if (run.lastCompletedPhase < 10) {
      await db.update(agentRuns).set({ status: "abandoned", endedAt: new Date() }).where(eq(agentRuns.id, run.id));
      await appendNotice(run.id, run.studentId, "commit", `Run recovered on startup — abandoned at phase ${run.lastCompletedPhase}, no changes committed.`);
      abandoned++;
      continue;
    }

    let versionLanded = false;
    if (run.newPlanVersion !== null) {
      const [plan] = await db.select({ id: studyPlans.id }).from(studyPlans).where(eq(studyPlans.studentId, run.studentId));
      if (plan) {
        const [version] = await db
          .select({ id: planVersions.id })
          .from(planVersions)
          .where(and(eq(planVersions.planId, plan.id), eq(planVersions.version, run.newPlanVersion)));
        versionLanded = Boolean(version);
      }
    }

    if (versionLanded) {
      await db.update(agentRuns).set({ status: "completed", endedAt: new Date() }).where(eq(agentRuns.id, run.id));
      await appendNotice(run.id, run.studentId, "commit", "Run recovered on startup — plan version had already landed; marked completed.");
      completed++;
    } else {
      await db
        .update(agentRuns)
        .set({
          status: "failed",
          endedAt: new Date(),
          errorClass: "crash_during_commit",
          errorDetail: "Process was interrupted during phase 10 and no plan version was found — the transaction did not land.",
        })
        .where(eq(agentRuns.id, run.id));
      await appendNotice(run.id, run.studentId, "commit", "Run recovered on startup — commit did not land; marked failed. Next tick will re-evaluate triggers.");
      failed++;
    }
  }

  // A breaker left `open` across a restart re-enters half_open once its window has elapsed —
  // otherwise a tool that recovered hours ago stays artificially degraded forever.
  const openBreakers = await db.query.toolHealth.findMany({ where: (t, { eq }) => eq(t.state, "open") });
  const halfOpened: string[] = [];
  const now = Date.now();
  for (const t of openBreakers) {
    const openedAt = t.openedAt?.getTime() ?? 0;
    if (now - openedAt >= OPEN_DURATION_MS) {
      await db.update(toolHealth).set({ state: "half_open" }).where(eq(toolHealth.toolName, t.toolName));
      halfOpened.push(t.toolName);
    }
  }

  return { abandoned, completed, failed, halfOpened };
}
