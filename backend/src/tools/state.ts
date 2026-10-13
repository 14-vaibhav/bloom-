/**
 * Student state tool. get_student_state is the expensive one — assembled
 * from parallel queries (bloom-phase2-brief.md §4.5), never one monstrous
 * join. save_plan_version is the one operation in the whole tool layer that
 * must be transactional: plan version, activities, and calendar sessions all
 * land together or not at all (bloom-prd-v3.md §16.4).
 *
 * `projection` in get_student_state is a placeholder (null) — the on-track
 * arithmetic in §9 needs the calendar tool's free/busy view plus the goal's
 * blueprint, and composing those across tool boundaries is the orchestrator's
 * job starting Phase 6, not this tool's.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agentEvents,
  agentRuns,
  calendarEvents,
  idempotencyKeys,
  learningActivities,
  learningGoals,
  planVersions,
  students,
  studyPlans,
} from "../db/schema.js";
import { PermanentError } from "./errors.js";
import { getSubtopicPerformance } from "./performance.js";
import { resolveEffectiveConstraints } from "./shared.js";
import type { ToolInput, ToolOutput } from "./schemas.js";

function activityRecord(a: typeof learningActivities.$inferSelect) {
  return {
    activity_id: a.id,
    subtopic_id: a.subtopicId,
    resource_id: a.resourceId,
    action: a.action,
    scheduled_start: a.scheduledStart.toISOString(),
    scheduled_end: a.scheduledEnd.toISOString(),
    duration_min: a.durationMin,
    priority: a.priority !== null ? Number(a.priority) : null,
    predicted_score: a.predictedScore !== null ? Number(a.predictedScore) : null,
    expected_mastery_after: a.expectedMasteryAfter !== null ? Number(a.expectedMasteryAfter) : null,
    status: a.status,
    provisional: a.provisional,
  };
}

export async function getStudentState(
  input: ToolInput<"state.get_student_state">,
): Promise<ToolOutput<"state.get_student_state">> {
  const [student] = await db.select().from(students).where(eq(students.id, input.student_id));
  if (!student) throw new PermanentError(`Student ${input.student_id} not found`);

  const [goalRow, masteryRows] = await Promise.all([
    db
      .select()
      .from(learningGoals)
      .where(and(eq(learningGoals.studentId, input.student_id), eq(learningGoals.status, "active")))
      .orderBy(desc(learningGoals.createdAt))
      .limit(1),
    db.query.subtopicMastery.findMany({ where: (m, { eq }) => eq(m.studentId, input.student_id) }),
  ]);

  const constraints = await resolveEffectiveConstraints(input.student_id, student.simNow);
  const goal = goalRow[0] ?? null;
  // Resolved via the active goal's id, not an unordered "first plan row for this student" —
  // a student can accumulate more than one studyPlans row (e.g. test fixtures).
  const plan = goal ? await db.select().from(studyPlans).where(eq(studyPlans.goalId, goal.id)).limit(1) : [];

  let planOut: ToolOutput<"state.get_student_state">["plan"] = null;
  if (plan[0]) {
    const activities = await db
      .select()
      .from(learningActivities)
      .where(
        and(
          eq(learningActivities.planId, plan[0].id),
          eq(learningActivities.planVersion, plan[0].currentVersion),
        ),
      );
    planOut = {
      plan_id: plan[0].id,
      current_version: plan[0].currentVersion,
      upcoming_activities: activities
        .filter((a) => a.status === "planned" || a.status === "in_progress")
        .map(activityRecord),
    };
  }

  const recentMastery = await getSubtopicPerformance({
    student_id: input.student_id,
    subtopic_ids: masteryRows.map((m) => m.subtopicId),
  });

  return {
    student: {
      id: student.id,
      name: student.name,
      email: student.email,
      sim_now: student.simNow.toISOString(),
    },
    goal: goal
      ? {
          goal_id: goal.id,
          subject_id: goal.subjectId,
          title: goal.title,
          deadline: goal.deadline,
          blueprint: goal.blueprint as Record<string, number>,
          target_mastery: goal.targetMastery as Record<string, number>,
          must_have_subtopics: goal.mustHaveSubtopics,
          status: goal.status,
        }
      : null,
    constraints: constraints
      ? {
          weekly_availability: constraints.weeklyAvailability as Record<
            string,
            Array<{ start: string; end: string }>
          >,
          max_daily_study_min: constraints.maxDailyStudyMin,
          min_session_min: constraints.minSessionMin,
          max_session_min: constraints.maxSessionMin,
          blackout_dates: constraints.blackoutDates,
          preferred_formats: constraints.preferredFormats,
          effective_from: constraints.effectiveFrom.toISOString(),
        }
      : null,
    plan: planOut,
    recent_mastery: recentMastery,
    projection: null,
  };
}

export async function patchStudentState(
  input: ToolInput<"state.patch_student_state">,
): Promise<ToolOutput<"state.patch_student_state">> {
  const patch: Partial<typeof students.$inferInsert> = {};
  if (input.patch.sim_now) patch.simNow = new Date(input.patch.sim_now);

  if (Object.keys(patch).length === 0) {
    const [existing] = await db.select().from(students).where(eq(students.id, input.student_id));
    if (!existing) throw new PermanentError(`Student ${input.student_id} not found`);
    return { id: existing.id, name: existing.name, email: existing.email, sim_now: existing.simNow.toISOString() };
  }

  const [row] = await db.update(students).set(patch).where(eq(students.id, input.student_id)).returning();
  if (!row) throw new PermanentError(`Student ${input.student_id} not found`);
  return { id: row.id, name: row.name, email: row.email, sim_now: row.simNow.toISOString() };
}

export async function appendObservation(
  input: ToolInput<"state.append_observation">,
): Promise<ToolOutput<"state.append_observation">> {
  const [run] = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, input.run_id));
  if (!run) throw new PermanentError(`agent_run ${input.run_id} not found`);

  const message = `${input.type}: ${JSON.stringify(input.payload ?? {}).slice(0, 200)}`;
  const phase = input.phase ?? "act";

  // seq computed from the max already used in this run so it stays monotonic even
  // though this write happens outside the dispatcher's own in-memory counter.
  const inserted = await db.transaction(async (tx) => {
    const result = await tx.execute<{ max_seq: number }>(
      sql`select coalesce(max(seq), 0) as max_seq from agent_events where run_id = ${input.run_id}`,
    );
    const nextSeq = Number(result.rows[0]?.max_seq ?? 0) + 1;
    const [r] = await tx
      .insert(agentEvents)
      .values({
        runId: input.run_id,
        studentId: input.student_id,
        seq: nextSeq,
        phase,
        eventType: "notice",
        message,
        payload: { type: input.type, ...(input.payload ?? {}) },
      })
      .returning({ id: agentEvents.id });
    return r;
  });

  return { event_id: inserted.id, message };
}

export async function getPlan(input: ToolInput<"state.get_plan">): Promise<ToolOutput<"state.get_plan">> {
  // Resolve via the active goal, not an unordered "first row for this student" — a student
  // can accumulate more than one studyPlans row (e.g. test fixtures reusing a shared id), and
  // only the plan tied to the currently-active goal is the one anything should ever show.
  const [activeGoal] = await db
    .select({ id: learningGoals.id })
    .from(learningGoals)
    .where(and(eq(learningGoals.studentId, input.student_id), eq(learningGoals.status, "active")))
    .orderBy(desc(learningGoals.createdAt))
    .limit(1);
  if (!activeGoal) return null;
  const [plan] = await db.select().from(studyPlans).where(eq(studyPlans.goalId, activeGoal.id));
  if (!plan) return null;

  const version = input.version ?? plan.currentVersion;
  const [versionRow] = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.planId, plan.id), eq(planVersions.version, version)));
  if (!versionRow) return null;

  const activities = await db
    .select()
    .from(learningActivities)
    .where(and(eq(learningActivities.planId, plan.id), eq(learningActivities.planVersion, version)));

  return {
    plan_id: plan.id,
    version: versionRow.version,
    parent_version: versionRow.parentVersion,
    trigger: versionRow.trigger,
    scope: versionRow.scope,
    reason: versionRow.reason,
    diff: versionRow.diff,
    validation_report: versionRow.validationReport,
    repair_rounds: versionRow.repairRounds,
    created_at: versionRow.createdAt.toISOString(),
    activities: activities.map(activityRecord),
  };
}

export async function savePlanVersion(
  input: ToolInput<"state.save_plan_version">,
): Promise<ToolOutput<"state.save_plan_version">> {
  if (input.idempotency_key) {
    const [cached] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, input.idempotency_key));
    if (cached) return cached.response as ToolOutput<"state.save_plan_version">;
  }

  const output = await db.transaction(async (tx) => {
    // Claim the key *inside* the commit transaction.  Checking only before the
    // transaction leaves a retry window: the plan can land, the process can die
    // before the key is stored, and the retry would create a second version.
    if (input.idempotency_key) {
      const claimed = await tx
        .insert(idempotencyKeys)
        .values({ key: input.idempotency_key, endpoint: "state.save_plan_version", response: null })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      if (claimed.length === 0) {
        const [cached] = await tx
          .select()
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, input.idempotency_key));
        if (cached?.response) return cached.response as ToolOutput<"state.save_plan_version">;
        throw new PermanentError(`Commit ${input.idempotency_key} is already in progress`);
      }
    }

    let planId = input.plan_id;
    if (!planId) {
      const [newPlan] = await tx
        .insert(studyPlans)
        .values({ studentId: input.student_id, goalId: input.goal_id, currentVersion: input.version })
        .returning({ id: studyPlans.id });
      planId = newPlan.id;
    } else {
      await tx.update(studyPlans).set({ currentVersion: input.version }).where(eq(studyPlans.id, planId));
    }

    const [versionRow] = await tx
      .insert(planVersions)
      .values({
        planId,
        version: input.version,
        parentVersion: input.parent_version ?? null,
        trigger: input.trigger,
        scope: input.scope,
        reason: input.reason,
        diff: input.diff ?? null,
        gapSnapshot: input.gap_snapshot ?? null,
        projection: input.projection ?? null,
        validationReport: input.validation_report ?? null,
        repairRounds: input.repair_rounds,
      })
      .returning({ id: planVersions.id });

    const supersedesIds = input.supersedes_activity_ids ?? [];
    if (supersedesIds.length > 0) {
      await tx.delete(calendarEvents).where(and(eq(calendarEvents.source, "bloom"), inArray(calendarEvents.activityId, supersedesIds)));
    }

    const activityIds: string[] = [];
    const calendarEventIds: string[] = [];

    for (const a of input.activities) {
      const [activityRow] = await tx
        .insert(learningActivities)
        .values({
          planId,
          planVersion: input.version,
          studentId: input.student_id,
          subtopicId: a.subtopic_id,
          resourceId: a.resource_id ?? null,
          action: a.action,
          scheduledStart: new Date(a.scheduled_start),
          scheduledEnd: new Date(a.scheduled_end),
          durationMin: a.duration_min,
          priority: a.priority !== undefined ? String(a.priority) : null,
          predictedScore: a.predicted_score !== undefined ? String(a.predicted_score) : null,
          expectedMasteryAfter: a.expected_mastery_after !== undefined ? String(a.expected_mastery_after) : null,
          carriedFromActivityId: a.carried_from_activity_id ?? null,
          provisional: a.provisional,
        })
        .returning({ id: learningActivities.id });
      activityIds.push(activityRow.id);

      if (a.create_calendar_session) {
        const [eventRow] = await tx
          .insert(calendarEvents)
          .values({
            studentId: input.student_id,
            title: `${a.action} ${a.subtopic_id}`,
            startsAt: new Date(a.scheduled_start),
            endsAt: new Date(a.scheduled_end),
            source: "bloom",
            busy: true,
            activityId: activityRow.id,
          })
          .returning({ id: calendarEvents.id });
        calendarEventIds.push(eventRow.id);
      }
    }

    if (input.run_id) {
      await tx
        .update(agentRuns)
        .set({ status: "completed", newPlanVersion: input.version, endedAt: new Date() })
        .where(eq(agentRuns.id, input.run_id));
    }

    const result = {
      plan_id: planId,
      plan_version_id: versionRow.id,
      version: input.version,
      activity_ids: activityIds,
      calendar_event_ids: calendarEventIds,
    };

    if (input.idempotency_key) {
      await tx
        .update(idempotencyKeys)
        .set({ response: result })
        .where(eq(idempotencyKeys.key, input.idempotency_key));
    }
    return result;
  });

  return output;
}

export async function getConstraints(
  input: ToolInput<"state.get_constraints">,
): Promise<ToolOutput<"state.get_constraints">> {
  const row = await resolveEffectiveConstraints(input.student_id, new Date(input.effective_at));
  if (!row) return null;
  return {
    weekly_availability: row.weeklyAvailability as Record<string, Array<{ start: string; end: string }>>,
    max_daily_study_min: row.maxDailyStudyMin,
    min_session_min: row.minSessionMin,
    max_session_min: row.maxSessionMin,
    blackout_dates: row.blackoutDates,
    preferred_formats: row.preferredFormats,
    effective_from: row.effectiveFrom.toISOString(),
  };
}
