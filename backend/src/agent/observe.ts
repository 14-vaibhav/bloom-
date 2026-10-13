/**
 * OBSERVE (phase 1) — collects what changed since the last tick
 * (bloom-phase6-brief §4). Two time domains are used deliberately, never
 * mixed:
 *
 *  - `sinceSimAt` (the previous run's simAt, sim-time) bounds everything this
 *    codebase timestamps in simulated time: activity completedAt/missedAt,
 *    which the planner and attendance arithmetic also treat as sim-time.
 *  - `sinceRealAt` (the previous run's startedAt, real wall-clock) bounds
 *    everything Bloom's own process timestamps for itself: agent_events,
 *    resource_feedback, tool_health transitions.
 *
 * Assessment submissions are the one input that would fall through both
 * domains (qbank.submit_answers stamps real wall-clock `new Date()`, a Phase
 * 5 choice this phase doesn't revisit) — so those are picked up by an
 * anti-join against mastery_observations instead of a time window: "has this
 * assessment_id already produced a belief update?" is domain-clock-agnostic
 * and idempotent by construction.
 */

import { and, desc, eq, gt, isNull, like, ne, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentRuns, assessmentResults, assessments, masteryObservations, studyPlans, subtopicMastery, tutorTurns } from "../db/schema.js";
import { markMissedActivities, type MissedActivity } from "./simClock.js";
import { resolveEffectiveConstraints } from "../tools/shared.js";

export type ObservationType =
  | "ACTIVITY_COMPLETED"
  | "ACTIVITY_MISSED"
  | "ASSESSMENT_SUBMITTED"
  | "AVAILABILITY_CHANGED"
  | "CALENDAR_EVENT_ADDED"
  | "GOAL_CHANGED"
  | "RESOURCE_FEEDBACK"
  | "TIME_ADVANCED"
  | "TOOL_RECOVERED"
  | "TUTOR_QUESTION_ASKED";

export type Observation = {
  type: ObservationType;
  at: Date;
  payload: Record<string, unknown>;
};

type WeeklyAvailability = Record<string, Array<{ start: string; end: string }>>;

function totalWeeklyMinutes(weekly: WeeklyAvailability): number {
  return Object.values(weekly)
    .flat()
    .reduce((sum, w) => {
      const [sh, sm] = w.start.split(":").map(Number);
      const [eh, em] = w.end.split(":").map(Number);
      return sum + (eh * 60 + em - (sh * 60 + sm));
    }, 0);
}

export type UnprocessedAssessment = {
  assessment_id: string;
  subtopic_id: string;
  purpose: string;
  predicted_score: number;
  score: number;
  per_subtopic: Record<string, number>;
  significant: boolean;
  prediction_error: number;
  submitted_at: Date;
  question_count: number;
  avg_difficulty: 1 | 2 | 3 | 4 | 5;
};

export type CollectedObservations = {
  observations: Observation[];
  missedThisTick: MissedActivity[];
  unprocessedAssessments: UnprocessedAssessment[];
};

/** Runs clock-driven miss detection, then gathers everything else that changed since the
 * previous tick. Always returns at least one TIME_ADVANCED observation, even when nothing
 * else did — that's what lets a tick with no user activity still make (and log) a decision. */
export async function collectObservations(opts: {
  studentId: string;
  now: Date; // sim_now at this tick
  sinceSimAt: Date; // previous run's simAt, or a floor if this is the first tick
  sinceRealAt: Date; // previous run's startedAt, or student.createdAt if this is the first
}): Promise<CollectedObservations> {
  const { studentId, now, sinceSimAt, sinceRealAt } = opts;
  const observations: Observation[] = [{ type: "TIME_ADVANCED", at: now, payload: { since: sinceSimAt.toISOString() } }];

  // ---- clock-driven miss detection (idempotent; see simClock.ts) --------------
  const missedThisTick = await markMissedActivities(studentId, now);
  for (const m of missedThisTick) {
    observations.push({ type: "ACTIVITY_MISSED", at: now, payload: { activity_id: m.id, subtopic_id: m.subtopicId, action: m.action } });
  }

  // ---- activities completed since the last tick (sim-time) ---------------------
  const [plan] = await db.select({ id: studyPlans.id, version: studyPlans.currentVersion }).from(studyPlans).where(eq(studyPlans.studentId, studentId));
  if (plan) {
    const completed = await db.query.learningActivities.findMany({
      where: (a, { and, eq, gt }) =>
        and(eq(a.studentId, studentId), eq(a.planId, plan.id), eq(a.status, "completed"), gt(a.completedAt, sinceSimAt)),
    });
    for (const a of completed) {
      observations.push({
        type: "ACTIVITY_COMPLETED",
        at: a.completedAt ?? now,
        payload: { activity_id: a.id, subtopic_id: a.subtopicId, action: a.action, plan_version: a.planVersion },
      });
    }

    // missed activities recorded in an EARLIER tick but not yet reported (defensive — the
    // common case is missedThisTick above, this only matters after a crash/restart gap).
    const missedEarlier = await db.query.learningActivities.findMany({
      where: (a, { and, eq, gt }) => and(eq(a.studentId, studentId), eq(a.planId, plan.id), eq(a.status, "missed"), gt(a.missedAt, sinceSimAt)),
    });
    const alreadyReported = new Set(missedThisTick.map((m) => m.id));
    for (const a of missedEarlier) {
      if (alreadyReported.has(a.id)) continue;
      observations.push({ type: "ACTIVITY_MISSED", at: a.missedAt ?? now, payload: { activity_id: a.id, subtopic_id: a.subtopicId, action: a.action } });
    }
  }

  // ---- assessments submitted but not yet reflected in a belief (clock-agnostic) --
  const rows = await db
    .select({ assessment: assessments, result: assessmentResults })
    .from(assessments)
    .innerJoin(assessmentResults, eq(assessmentResults.assessmentId, assessments.id))
    .leftJoin(
      masteryObservations,
      // source_id is text (it also holds activity ids for non-assessment sources), assessments.id
      // is uuid — Postgres has no implicit text = uuid operator, so the uuid side needs an
      // explicit cast. This path only runs once an assessment_results row exists, which no
      // prior test exercised through the full tick() pipeline (there is no orchestrator.test.ts).
      and(eq(masteryObservations.source, "assessment"), eq(masteryObservations.sourceId, sql`${assessments.id}::text`), eq(masteryObservations.studentId, studentId)),
    )
    .where(and(eq(assessments.studentId, studentId), isNull(masteryObservations.id)));

  const allQuestionIds = [...new Set(rows.flatMap((r) => r.assessment.questionIds))];
  const difficultyById = new Map<string, number>();
  if (allQuestionIds.length > 0) {
    const qRows = await db.query.questions.findMany({
      where: (q, { inArray: inA }) => inA(q.id, allQuestionIds),
      columns: { id: true, difficulty: true },
    });
    for (const q of qRows) difficultyById.set(q.id, q.difficulty);
  }

  const unprocessedAssessments: UnprocessedAssessment[] = rows.map((r) => {
    const difficulties = r.assessment.questionIds.map((id) => difficultyById.get(id)).filter((d): d is number => d !== undefined);
    const avgDifficulty = difficulties.length > 0 ? Math.round(difficulties.reduce((s, d) => s + d, 0) / difficulties.length) : 3;
    return {
      assessment_id: r.assessment.id,
      subtopic_id: r.assessment.subtopicIds[0],
      purpose: r.assessment.purpose,
      predicted_score: Number(r.assessment.predictedScore),
      score: Number(r.result.score),
      per_subtopic: r.result.perSubtopic as Record<string, number>,
      significant: Math.abs(Number(r.result.predictionError)) > 0.15,
      prediction_error: Number(r.result.predictionError),
      submitted_at: r.result.submittedAt,
      question_count: r.assessment.questionIds.length,
      avg_difficulty: Math.min(5, Math.max(1, avgDifficulty)) as 1 | 2 | 3 | 4 | 5,
    };
  });
  for (const a of unprocessedAssessments) {
    observations.push({
      type: "ASSESSMENT_SUBMITTED",
      at: a.submitted_at,
      payload: { assessment_id: a.assessment_id, subtopic_id: a.subtopic_id, score: a.score, predicted_score: a.predicted_score, significant: a.significant },
    });
  }

  // ---- availability change: current effective constraints vs. as of the last tick --
  const [before, after] = await Promise.all([
    resolveEffectiveConstraints(studentId, sinceSimAt),
    resolveEffectiveConstraints(studentId, now),
  ]);
  if (before && after && before.effectiveFrom.getTime() !== after.effectiveFrom.getTime()) {
    const beforeMin = totalWeeklyMinutes(before.weeklyAvailability as WeeklyAvailability);
    const afterMin = totalWeeklyMinutes(after.weeklyAvailability as WeeklyAvailability);
    const delta = beforeMin > 0 ? Math.abs(afterMin - beforeMin) / beforeMin : afterMin > 0 ? 1 : 0;
    observations.push({
      type: "AVAILABILITY_CHANGED",
      at: after.effectiveFrom,
      payload: { before_weekly_min: beforeMin, after_weekly_min: afterMin, delta_ratio: delta },
    });
  } else if (!before && after) {
    observations.push({ type: "AVAILABILITY_CHANGED", at: after.effectiveFrom, payload: { before_weekly_min: 0, after_weekly_min: null, delta_ratio: 1 } });
  }

  // ---- resource feedback recorded since the last tick (real wall-clock; Bloom's own) --
  const feedback = await db.query.resourceFeedback.findMany({
    where: (f, { and, eq, gt }) => and(eq(f.studentId, studentId), gt(f.createdAt, sinceRealAt)),
  });
  for (const f of feedback) {
    if (f.rating === "helpful") continue;
    observations.push({ type: "RESOURCE_FEEDBACK", at: f.createdAt, payload: { resource_id: f.resourceId, rating: f.rating } });
  }

  // ---- tools that recovered since the last tick (real wall-clock; Bloom's own) --------
  const recovered = await db.query.toolHealth.findMany({
    where: (t, { and, eq, gt, isNotNull }) => and(eq(t.state, "closed"), isNotNull(t.lastSuccessAt), gt(t.lastSuccessAt, sinceRealAt)),
  });
  for (const t of recovered) {
    const hadRecoveryEvent = await db.query.agentEvents.findFirst({
      where: (e, { and, eq, gt, like }) =>
        and(eq(e.studentId, studentId), eq(e.toolName, t.toolName), gt(e.createdAt, sinceRealAt), like(e.message, "%circuit closed — tool recovered%")),
    });
    if (hadRecoveryEvent) observations.push({ type: "TOOL_RECOVERED", at: t.lastSuccessAt!, payload: { tool: t.toolName } });
  }

  // ---- new external calendar events since the last tick (best-effort; no createdAt
  // column exists on calendar_events, so this scans starts_at going forward from now —
  // a genuinely "new" event added for a future date is indistinguishable from one that
  // was always there, but either way it's a real conflict worth surfacing once). ------
  if (plan) {
    const upcomingExternal = await db.query.calendarEvents.findMany({
      where: (c, { and, eq, gte }) => and(eq(c.studentId, studentId), eq(c.source, "external"), gte(c.startsAt, now)),
    });
    const plannedBloom = await db.query.learningActivities.findMany({
      where: (a, { and, eq }) => and(eq(a.studentId, studentId), eq(a.planId, plan.id), eq(a.planVersion, plan.version), eq(a.status, "planned")),
    });
    for (const ext of upcomingExternal) {
      const conflict = plannedBloom.find((b) => b.scheduledStart < ext.endsAt && ext.startsAt < b.scheduledEnd);
      if (conflict) {
        observations.push({
          type: "CALENDAR_EVENT_ADDED",
          at: now,
          payload: { calendar_event_id: ext.id, activity_id: conflict.id, subtopic_id: conflict.subtopicId },
        });
      }
    }
  }

  // ---- tutor questions in the last 48 sim hours not yet acted on (v4 §N7.1). The tutor row IS the
  // observation: state.append_observation needs an agent_runs row, and tutor turns must not invent runs.
  const windowStart = new Date(now.getTime() - 48 * 3_600_000);
  const [lastConfusionRun] = await db
    .select({ simAt: agentRuns.simAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.studentId, studentId), like(agentRuns.trigger, "%CONFUSION_SIGNAL%"), ne(agentRuns.status, "failed")))
    .orderBy(desc(agentRuns.simAt))
    .limit(1);
  const since = lastConfusionRun?.simAt && lastConfusionRun.simAt > windowStart ? lastConfusionRun.simAt : windowStart;
  const turns = await db
    .select({ id: tutorTurns.id, askedAt: tutorTurns.askedAt, subtopicIds: tutorTurns.subtopicIds })
    .from(tutorTurns)
    .where(and(eq(tutorTurns.studentId, studentId), gt(tutorTurns.askedAt, since)));
  const answeredTurns = turns.filter((t) => t.subtopicIds.length > 0 && t.askedAt <= now);
  if (answeredTurns.length > 0) {
    const mastery = await db.select({ subtopicId: subtopicMastery.subtopicId, confidence: subtopicMastery.confidence }).from(subtopicMastery).where(eq(subtopicMastery.studentId, studentId));
    const confidenceBySubtopic = new Map(mastery.map((m) => [m.subtopicId, Number(m.confidence)]));
    for (const t of answeredTurns) {
      const subtopicId = t.subtopicIds[0];
      observations.push({
        type: "TUTOR_QUESTION_ASKED", at: t.askedAt,
        payload: { turn_id: t.id, subtopic_id: subtopicId, confidence: confidenceBySubtopic.get(subtopicId) ?? 0 },
      });
    }
  }

  observations.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { observations, missedThisTick, unprocessedAssessments };
}
