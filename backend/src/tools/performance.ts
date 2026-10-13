/**
 * Performance tool — read-only rollups over mastery, assessments, and
 * completion history. Grain is always subtopic; there is deliberately no
 * get_topic_performance (bloom-phase2-brief.md §4.1) — topic/subject numbers
 * are computed rollups the caller does itself, so there is only one place
 * mastery numbers can live.
 */

import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  assessmentResults,
  assessments,
  learningActivities,
  masteryObservations,
  subtopicMastery,
  subtopics,
} from "../db/schema.js";
import { PermanentError } from "./errors.js";
import type { ToolInput, ToolOutput } from "./schemas.js";

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

export async function getStudentPerformance(
  input: ToolInput<"performance.get_student_performance">,
): Promise<ToolOutput<"performance.get_student_performance">> {
  const [masteryRows, subtopicRows, since14, sinceAssessments] = await Promise.all([
    db.select().from(subtopicMastery).where(eq(subtopicMastery.studentId, input.student_id)),
    db.select({ id: subtopics.id, weight: subtopics.weight }).from(subtopics),
    db
      .select()
      .from(learningActivities)
      .where(
        and(
          eq(learningActivities.studentId, input.student_id),
          gte(learningActivities.scheduledStart, new Date(Date.now() - 14 * 86400000)),
        ),
      ),
    db.select().from(assessments).where(eq(assessments.studentId, input.student_id)),
  ]);

  const weightById = new Map(subtopicRows.map((s) => [s.id, num(s.weight)]));
  let weightedSum = 0;
  let weightTotal = 0;
  for (const m of masteryRows) {
    const w = weightById.get(m.subtopicId) ?? 0;
    weightedSum += w * num(m.mu);
    weightTotal += w;
  }
  const overallMastery = weightTotal > 0 ? weightedSum / weightTotal : 0;

  const observationsSince = await db
    .select()
    .from(masteryObservations)
    .where(
      and(
        eq(masteryObservations.studentId, input.student_id),
        gte(masteryObservations.observedAt, new Date(Date.now() - 7 * 86400000)),
      ),
    );
  const trend7d =
    observationsSince.length > 0
      ? observationsSince.reduce((acc, o) => acc + (num(o.muAfter) - num(o.muBefore)), 0) / observationsSince.length
      : null;

  const completed14 = since14.filter((a) => a.status === "completed").length;
  const missed14 = since14.filter((a) => a.status === "missed").length;
  const completionRatio14d = completed14 + missed14 > 0 ? completed14 / (completed14 + missed14) : null;

  const totalStudyMinutes = since14
    .filter((a) => a.status === "completed")
    .reduce((acc, a) => acc + (a.actualDurationMin ?? a.durationMin), 0);

  const submitted = sinceAssessments.filter((a) => a.submittedAt !== null);
  const lastActivity = since14
    .filter((a) => a.completedAt)
    .sort((a, b) => (b.completedAt as Date).getTime() - (a.completedAt as Date).getTime())[0];

  return {
    overall_mastery: overallMastery,
    trend_7d: trend7d,
    completion_ratio_14d: completionRatio14d,
    total_study_minutes: totalStudyMinutes,
    assessments_taken: submitted.length,
    last_activity_at: lastActivity?.completedAt ? (lastActivity.completedAt as Date).toISOString() : null,
  };
}

export async function getSubtopicPerformance(
  input: ToolInput<"performance.get_subtopic_performance">,
): Promise<ToolOutput<"performance.get_subtopic_performance">> {
  const targetIds =
    input.subtopic_ids ?? (await db.select({ id: subtopics.id }).from(subtopics)).map((r) => r.id);

  const [masteryRows, allObservations, allResults] = await Promise.all([
    db
      .select()
      .from(subtopicMastery)
      .where(
        and(eq(subtopicMastery.studentId, input.student_id), inArray(subtopicMastery.subtopicId, targetIds)),
      ),
    db
      .select()
      .from(masteryObservations)
      .where(
        and(
          eq(masteryObservations.studentId, input.student_id),
          inArray(masteryObservations.subtopicId, targetIds),
        ),
      ),
    db
      .select({ perSubtopic: assessmentResults.perSubtopic, submittedAt: assessmentResults.submittedAt })
      .from(assessmentResults)
      .innerJoin(assessments, eq(assessments.id, assessmentResults.assessmentId))
      .where(eq(assessments.studentId, input.student_id)),
  ]);

  const masteryBySubtopic = new Map(masteryRows.map((m) => [m.subtopicId, m]));
  const now = Date.now();

  return targetIds.map((subtopicId) => {
    const m = masteryBySubtopic.get(subtopicId);
    const obs = allObservations
      .filter((o) => o.subtopicId === subtopicId)
      .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    const recentScores = allResults
      .filter((r) => typeof (r.perSubtopic as Record<string, number>)[subtopicId] === "number")
      .sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0))
      .slice(0, 5)
      .map((r) => (r.perSubtopic as Record<string, number>)[subtopicId]);

    const trend =
      obs.length >= 2 ? num(obs[obs.length - 1].muAfter) - num(obs[0].muBefore) : obs.length === 1 ? num(obs[0].muAfter) - num(obs[0].muBefore) : null;

    const daysStale = m?.lastObservedAt ? (now - m.lastObservedAt.getTime()) / 86400000 : null;

    return {
      subtopic_id: subtopicId,
      mu: num(m?.mu ?? 0),
      confidence: num(m?.confidence ?? 0),
      learn_rate: num(m?.learnRate ?? 0.1),
      evidence_count: m?.evidenceCount ?? 0,
      retention_estimate: m?.retentionEstimate !== null && m?.retentionEstimate !== undefined ? num(m.retentionEstimate) : null,
      strength_days: m?.strengthDays !== null && m?.strengthDays !== undefined ? num(m.strengthDays) : null,
      days_stale: daysStale,
      recent_scores: recentScores,
      trend,
      minutes_invested: 0, // filled from completion history at the caller when needed — avoids a second full activity scan here
      format_efficacy: (m?.formatEfficacy as Record<string, number>) ?? { video: 0.1, article: 0.1, practice: 0.1 },
    };
  });
}

export async function getAssessmentHistory(
  input: ToolInput<"performance.get_assessment_history">,
): Promise<ToolOutput<"performance.get_assessment_history">> {
  const rows = await db
    .select({ assessment: assessments, result: assessmentResults })
    .from(assessments)
    .leftJoin(assessmentResults, eq(assessmentResults.assessmentId, assessments.id))
    .where(eq(assessments.studentId, input.student_id))
    .orderBy(assessments.createdAt)
    .limit(input.limit ?? 20);

  return rows
    .sort((a, b) => b.assessment.createdAt.getTime() - a.assessment.createdAt.getTime())
    .map(({ assessment, result }) => ({
      assessment_id: assessment.id,
      purpose: assessment.purpose,
      subtopic_ids: assessment.subtopicIds,
      score: result ? num(result.score) : null,
      predicted_score: num(assessment.predictedScore),
      prediction_error: result ? num(result.predictionError) : null,
      submitted_at: assessment.submittedAt ? assessment.submittedAt.toISOString() : null,
      questions: (result?.answers as Array<Record<string, unknown>> | undefined ?? []).map((a) => ({
        question_id: a.question_id as string,
        subtopic_id: a.subtopic_id as string,
        concept_id: (a.concept_id as string) ?? null,
        chosen_index: (a.chosen_index as number) ?? null,
        correct_index: a.correct_index as number,
        correct: (a.correct as boolean) ?? null,
      })),
    }));
}

export async function getCompletionHistory(
  input: ToolInput<"performance.get_completion_history">,
): Promise<ToolOutput<"performance.get_completion_history">> {
  const since = new Date(input.since);
  if (Number.isNaN(since.getTime())) {
    throw new PermanentError(`Invalid \`since\` timestamp: ${input.since}`);
  }
  const rows = await db
    .select()
    .from(learningActivities)
    .where(and(eq(learningActivities.studentId, input.student_id), gte(learningActivities.scheduledStart, since)));

  return rows.map((a) => ({
    activity_id: a.id,
    subtopic_id: a.subtopicId,
    action: a.action,
    status: a.status,
    scheduled_start: a.scheduledStart.toISOString(),
    scheduled_end: a.scheduledEnd.toISOString(),
    scheduled_duration_min: a.durationMin,
    actual_duration_min: a.actualDurationMin,
    self_rated_difficulty: a.selfRatedDifficulty,
    completed_at: a.completedAt ? a.completedAt.toISOString() : null,
  }));
}
