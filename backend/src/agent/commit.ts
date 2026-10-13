/**
 * COMMIT (phase 10, bloom-phase6-brief §7). The only phase allowed to change
 * plan/activity/calendar state. Goes through state.save_plan_version — the
 * one tool operation that is itself transactional — so a crash here either
 * lands everything or nothing (bloom-prd-v3 §16.4).
 */

import { callTool } from "../tools/dispatcher.js";
import type { AgentContext } from "../tools/context.js";
import { computePlanDiff, type DiffAfterActivity, type DiffBeforeActivity, type PlanDiff } from "./diff.js";

/** The six persistable actions — learning_activities.action has no NONE or MILESTONE.
 * NONE never reaches a plan; MILESTONE (planner.ts's own multi-subtopic checkpoint) is out
 * of scope for this phase — types.ts explicitly leaves its persistence shape open, and
 * committing it as a bare learning_activities row would misrepresent it as single-subtopic. */
export type PersistableAction = "LEARN" | "PRACTICE" | "IMMEDIATE_TEST" | "ACTIVE_RECALL" | "REVISION" | "FINAL_TEST";

export type CommitActivity = {
  carried_from_activity_id?: string; // omit for a brand-new activity
  subtopic_id: string;
  resource_id?: string | null;
  action: PersistableAction;
  start: Date;
  end: Date;
  duration_min: number;
  priority?: number | null;
  predicted_score?: number | null;
  expected_mastery_after?: number | null;
  provisional?: boolean;
};

export type CommitParams = {
  studentId: string;
  goalId: string;
  trigger: string;
  scope: "PATCH" | "FULL" | "NEGOTIATE";
  reason: string;
  activities: CommitActivity[]; // the FULL forward-looking set for the new version
  gapSnapshot?: unknown;
  projection?: unknown;
  validationReport?: unknown;
  repairRounds?: number;
  runId: string;
  idempotencyKey?: string;
};

export type CommitOutcome = {
  plan_id: string;
  version: number;
  activity_ids: string[];
  calendar_event_ids: string[];
  diff: PlanDiff;
};

/**
 * Loads the current plan (if any), diffs the incoming activity set against
 * its still-`planned`/`in_progress` activities (completed/missed activities
 * are historical and never re-diffed — §16.5), deletes their now-superseded
 * calendar events, and inserts the new version in one transaction.
 */
export async function commitPlan(ctx: AgentContext, params: CommitParams): Promise<CommitOutcome> {
  const existing = await callTool(ctx, "state.get_plan", { student_id: params.studentId });

  const stillOpen = (existing?.activities ?? []).filter((a) => a.status === "planned" || a.status === "in_progress");
  const beforeForDiff: DiffBeforeActivity[] = stillOpen.map((a) => ({
    activity_id: a.activity_id,
    subtopic_id: a.subtopic_id,
    action: a.action,
    start: a.scheduled_start,
    end: a.scheduled_end,
    resource_id: a.resource_id,
    duration_min: a.duration_min,
  }));

  const afterForDiff: DiffAfterActivity[] = params.activities.map((a) => ({
    activity_id: a.carried_from_activity_id ?? `new:${a.subtopic_id}:${a.action}:${a.start.toISOString()}`,
    subtopic_id: a.subtopic_id,
    action: a.action,
    start: a.start.toISOString(),
    end: a.end.toISOString(),
    resource_id: a.resource_id ?? null,
    duration_min: a.duration_min,
    carried_from_activity_id: a.carried_from_activity_id ?? null,
  }));

  const diff = computePlanDiff(beforeForDiff, afterForDiff);

  const version = existing ? existing.version + 1 : 1;
  const result = await callTool(ctx, "state.save_plan_version", {
    student_id: params.studentId,
    goal_id: params.goalId,
    plan_id: existing?.plan_id,
    version,
    parent_version: existing?.version ?? null,
    trigger: params.trigger,
    scope: params.scope,
    reason: params.reason,
    diff,
    gap_snapshot: params.gapSnapshot,
    projection: params.projection,
    validation_report: params.validationReport,
    repair_rounds: params.repairRounds ?? 0,
    run_id: params.runId,
    supersedes_activity_ids: stillOpen.map((a) => a.activity_id),
    activities: params.activities.map((a) => ({
      subtopic_id: a.subtopic_id,
      resource_id: a.resource_id ?? null,
      action: a.action,
      scheduled_start: a.start.toISOString(),
      scheduled_end: a.end.toISOString(),
      duration_min: a.duration_min,
      priority: a.priority ?? undefined,
      predicted_score: a.predicted_score ?? undefined,
      expected_mastery_after: a.expected_mastery_after ?? undefined,
      carried_from_activity_id: a.carried_from_activity_id,
      provisional: a.provisional ?? false,
      create_calendar_session: true,
    })),
    // A run can be retried after a process interruption.  Its commit must be
    // replay-safe even when the caller did not supply a transport-level key.
    idempotency_key: params.idempotencyKey ?? `agent-run:${params.runId}:commit`,
  });

  return { plan_id: result.plan_id, version: result.version, activity_ids: result.activity_ids, calendar_event_ids: result.calendar_event_ids, diff };
}
