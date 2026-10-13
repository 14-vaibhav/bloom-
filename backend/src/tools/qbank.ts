/**
 * Question bank tool. Two boundaries held throughout (bloom-phase2-brief.md §4.4,
 * updated by bloom-phase5-brief.md §3-4):
 *
 *  - compose_assessment fetches the candidate pools (new/revision/correct/targeted)
 *    from the DB and hands them to the pure `composer.composeAssessment` — the
 *    per-purpose mix, the adaptive final-test shape, and the three predicted-score
 *    estimators all live there, not here. This function is the DB boundary only.
 *  - submit_answers scores and records attempts; it never touches
 *    subtopic_mastery. Scoring itself is delegated to the pure
 *    `scorer.scoreAssessment`; persistence (questionAttempts, question_state,
 *    assessment_results) stays here. Belief updating is a model, and Phase 3
 *    owns the model.
 *
 * get_revision_pool reads question_state.in_revision_pool /.weakness_score —
 * two columns added in this phase (not in the original Phase 1 schema)
 * because the op needs somewhere deterministic to read from. submit_answers
 * is what sets them: a wrong answer flags the question, a right one clears
 * it. That's arithmetic bookkeeping, not the weakness *model* Phase 5 builds
 * on top of it.
 *
 * predicted_score immutability (bloom-phase5-brief §3.3): nothing in this file, or
 * anywhere else in the codebase, ever updates `assessments.predictedScore` after the
 * INSERT in composeAssessment. There is no code path that could — guard this by not
 * adding one, not by adding a defensive check to a write that doesn't exist.
 */

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { composeAssessment as composePure } from "../core/composer.js";
import { scoreAssessment as scorePure } from "../core/scorer.js";
import type { Difficulty, QuestionCandidate, QuestionMeta } from "../core/types.js";
import { db } from "../db/client.js";
import {
  assessmentResults,
  assessments,
  idempotencyKeys,
  questionAttempts,
  questionState,
  questions,
  subtopicMastery,
} from "../db/schema.js";
import { PermanentError, ValidationError } from "./errors.js";
import { reviewSourcesFor } from "../kb/reviewSources.js";
import type { ToolInput, ToolOutput } from "./schemas.js";

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

function toPublic(q: typeof questions.$inferSelect): ToolOutput<"qbank.get_questions">[number] {
  return {
    question_id: q.id,
    subtopic_id: q.subtopicId,
    concept_id: q.conceptId,
    difficulty: q.difficulty,
    stem: q.stem,
    options: q.options as string[],
  };
}

export async function getQuestions(
  input: ToolInput<"qbank.get_questions">,
): Promise<ToolOutput<"qbank.get_questions">> {
  let seenIds: string[] = [];
  if (input.exclude_seen && input.student_id) {
    const seen = await db
      .select({ questionId: questionState.questionId })
      .from(questionState)
      .where(and(eq(questionState.studentId, input.student_id), sql`${questionState.timesSeen} > 0`));
    seenIds = seen.map((s) => s.questionId);
  }

  const conditions = [inArray(questions.subtopicId, input.subtopic_ids)];
  if (input.reviewed_only) conditions.push(eq(questions.reviewed, true));
  if (input.difficulty !== undefined) conditions.push(eq(questions.difficulty, input.difficulty));
  if (seenIds.length > 0) conditions.push(notInArray(questions.id, seenIds));

  const rows = await db
    .select()
    .from(questions)
    .where(and(...conditions))
    .orderBy(sql`random()`)
    .limit(input.count);

  return rows.map(toPublic);
}

/** Unseen questions for a subtopic — the "new" pool for every purpose. */
async function fetchNewPool(studentId: string, subtopicId: string, limit: number): Promise<QuestionCandidate[]> {
  const rows = await getQuestions({ subtopic_ids: [subtopicId], count: limit, exclude_seen: true, student_id: studentId, reviewed_only: true });
  return rows.map((q) => ({ question_id: q.question_id, concept_id: q.concept_id, difficulty: q.difficulty as Difficulty, weakness_score: 0 }));
}

/** Previously-seen questions for a subtopic, split by their current question_state flag —
 * `in_revision_pool` (wrong, unresolved) vs. not (last outcome correct). */
async function fetchSeenPools(
  studentId: string,
  subtopicId: string,
): Promise<{ revision: QuestionCandidate[]; correct: QuestionCandidate[] }> {
  const rows = await db
    .select({ state: questionState, question: questions })
    .from(questionState)
    .innerJoin(questions, eq(questions.id, questionState.questionId))
    .where(and(eq(questionState.studentId, studentId), eq(questions.subtopicId, subtopicId), sql`${questionState.timesSeen} > 0`))
    .orderBy(sql`${questionState.weaknessScore} desc`);

  const revision: QuestionCandidate[] = [];
  const correct: QuestionCandidate[] = [];
  for (const r of rows) {
    const candidate: QuestionCandidate = {
      question_id: r.question.id,
      concept_id: r.question.conceptId,
      difficulty: r.question.difficulty as Difficulty,
      weakness_score: num(r.state.weaknessScore),
    };
    (r.state.inRevisionPool ? revision : correct).push(candidate);
  }
  return { revision, correct };
}

/** Per-concept accuracy for this student+subtopic, and the unseen-question pool for
 * whichever concept has the lowest accuracy (bloom-phase5-brief §3.4). */
async function fetchTargetedPool(
  studentId: string,
  subtopicId: string,
): Promise<{ conceptAccuracy: Record<string, number>; targeted: QuestionCandidate[] }> {
  const attempts = await db
    .select({ conceptId: questions.conceptId, correct: questionAttempts.correct })
    .from(questionAttempts)
    .innerJoin(questions, eq(questions.id, questionAttempts.questionId))
    .where(and(eq(questionAttempts.studentId, studentId), eq(questions.subtopicId, subtopicId)));

  const byConcept = new Map<string, { correct: number; total: number }>();
  for (const a of attempts) {
    if (!a.conceptId) continue;
    const e = byConcept.get(a.conceptId) ?? { correct: 0, total: 0 };
    e.total += 1;
    if (a.correct) e.correct += 1;
    byConcept.set(a.conceptId, e);
  }
  const conceptAccuracy = Object.fromEntries([...byConcept].map(([k, v]) => [k, v.correct / v.total]));
  const weakestConceptId = [...byConcept.entries()].sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total)[0]?.[0];

  if (!weakestConceptId) return { conceptAccuracy, targeted: [] };

  const seen = await db
    .select({ questionId: questionState.questionId })
    .from(questionState)
    .where(and(eq(questionState.studentId, studentId), sql`${questionState.timesSeen} > 0`));
  const seenIds = seen.map((s) => s.questionId);

  const conditions = [eq(questions.subtopicId, subtopicId), eq(questions.conceptId, weakestConceptId), eq(questions.reviewed, true)];
  if (seenIds.length > 0) conditions.push(notInArray(questions.id, seenIds));
  const targetedRows = await db.select().from(questions).where(and(...conditions)).limit(20);

  const targeted = targetedRows.map((q) => ({ question_id: q.id, concept_id: q.conceptId, difficulty: q.difficulty as Difficulty, weakness_score: 0 }));
  return { conceptAccuracy, targeted };
}

export async function composeAssessment(
  input: ToolInput<"qbank.compose_assessment">,
): Promise<ToolOutput<"qbank.compose_assessment">> {
  if (input.idempotency_key) {
    const [cached] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, input.idempotency_key));
    if (cached) return cached.response as ToolOutput<"qbank.compose_assessment">;
  }

  const [mastery] = await db
    .select({ mu: subtopicMastery.mu })
    .from(subtopicMastery)
    .where(and(eq(subtopicMastery.studentId, input.student_id), eq(subtopicMastery.subtopicId, input.subtopic_id)));
  const mu = mastery ? num(mastery.mu) : 0.5;

  const [{ revision: revisionPool, correct: correctPool }, { conceptAccuracy, targeted: targetedPool }, newPool] = await Promise.all([
    fetchSeenPools(input.student_id, input.subtopic_id),
    fetchTargetedPool(input.student_id, input.subtopic_id),
    fetchNewPool(input.student_id, input.subtopic_id, Math.max(input.count, 20)),
  ]);

  const composed = composePure({
    purpose: input.purpose === "checkpoint" ? "immediate" : input.purpose, // "checkpoint" predates §3.1's 5-purpose split
    mu,
    concept_accuracy: conceptAccuracy,
    new_pool: newPool,
    correct_pool: correctPool,
    revision_pool: revisionPool,
    targeted_pool: targetedPool,
  });

  const [row] = await db
    .insert(assessments)
    .values({
      studentId: input.student_id,
      purpose: input.purpose,
      subtopicIds: [input.subtopic_id],
      questionIds: composed.question_ids,
      composition: composed.composition,
      predictedScore: String(composed.predicted_score),
    })
    .returning();

  const output: ToolOutput<"qbank.compose_assessment"> = {
    assessment_id: row.id,
    subtopic_ids: row.subtopicIds,
    purpose: row.purpose,
    question_ids: row.questionIds,
    composition: row.composition as { new: number; revision: number; targeted: number; correct: number },
    predicted_score: num(row.predictedScore),
    created_at: row.createdAt.toISOString(),
  };

  if (input.idempotency_key) {
    await db
      .insert(idempotencyKeys)
      .values({ key: input.idempotency_key, endpoint: "qbank.compose_assessment", response: output })
      .onConflictDoNothing();
  }

  return output;
}

export async function submitAnswers(
  input: ToolInput<"qbank.submit_answers">,
): Promise<ToolOutput<"qbank.submit_answers">> {
  if (input.idempotency_key) {
    const [cached] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, input.idempotency_key));
    if (cached) return cached.response as ToolOutput<"qbank.submit_answers">;
  }

  const [assessment] = await db.select().from(assessments).where(eq(assessments.id, input.assessment_id));
  if (!assessment) throw new PermanentError(`Assessment ${input.assessment_id} not found`);

  // Already submitted — a double-click or a retried request. Return what actually happened,
  // don't re-score (bloom-prd-v3.md §16.5: "assessment submitted twice -> second returns the first result").
  if (assessment.submittedAt) {
    const [existing] = await db
      .select()
      .from(assessmentResults)
      .where(eq(assessmentResults.assessmentId, assessment.id));
    if (existing) {
      return {
        assessment_id: assessment.id,
        score: num(existing.score),
        per_subtopic: existing.perSubtopic as Record<string, number>,
        per_concept: existing.perConcept as Record<string, { correct: number; total: number; accuracy: number }>,
        prediction_error: num(existing.predictionError),
        significant: false,
        submitted_at: existing.submittedAt.toISOString(),
        revision_pool_additions: [],
        cleared_questions: [],
        review_sources: {},
        review_sources_note: null,
      };
    }
  }

  const answeredIds = input.answers.map((a) => a.question_id);
  const unknown = answeredIds.filter((id) => !assessment.questionIds.includes(id));
  if (unknown.length > 0) {
    throw new ValidationError(`Answers reference questions not in assessment ${assessment.id}: ${unknown.join(", ")}`);
  }

  // A referenced question may have been deleted since composition (§16.5) — drop it and recompose the score set.
  const questionRows = await db.select().from(questions).where(inArray(questions.id, answeredIds));
  const questionById = new Map(questionRows.map((q) => [q.id, q]));
  const droppedIds = answeredIds.filter((id) => !questionById.has(id));

  // Read prior question_state BEFORE this submission's own writes touch it — that's what
  // "was_in_revision_pool" in the scorer means (§4's cleared_questions).
  const priorStates = await db
    .select()
    .from(questionState)
    .where(and(eq(questionState.studentId, assessment.studentId), inArray(questionState.questionId, [...questionById.keys()])));
  const priorInRevision = new Map(priorStates.map((s) => [s.questionId, s.inRevisionPool]));

  const answeredEligible = input.answers.filter((a) => questionById.has(a.question_id));
  if (answeredEligible.length === 0) {
    throw new ValidationError(`No answers in ${assessment.id} reference questions that still exist.`);
  }

  const questionMeta: QuestionMeta[] = [...questionById.values()].map((q) => ({
    question_id: q.id,
    subtopic_id: q.subtopicId,
    concept_id: q.conceptId,
    difficulty: q.difficulty as Difficulty,
    correct_index: q.correctIndex,
    was_in_revision_pool: priorInRevision.get(q.id) ?? false,
  }));

  const scored = scorePure({
    predicted_score: num(assessment.predictedScore),
    answers: answeredEligible.map((a) => ({ question_id: a.question_id, chosen_index: a.chosen_index })),
    questions: questionMeta,
  });
  if (!scored.ok) throw new ValidationError(`submit_answers(${assessment.id}): ${scored.error}`);
  const { score, per_subtopic: perSubtopic, per_concept: perConcept, prediction_error: predictionError, significant, newly_weak_questions, cleared_questions } = scored.result;

  const graded = answeredEligible.map((a) => {
    const q = questionById.get(a.question_id)!;
    return { answer: a, question: q, correct: a.chosen_index === q.correctIndex };
  });

  const submittedAt = new Date();

  await db.transaction(async (tx) => {
    for (const g of graded) {
      await tx.insert(questionAttempts).values({
        studentId: assessment.studentId,
        questionId: g.question.id,
        assessmentId: assessment.id,
        chosenIndex: g.answer.chosen_index,
        correct: g.correct,
        timeSec: g.answer.time_sec ?? null,
      });

      const [existingState] = await tx
        .select()
        .from(questionState)
        .where(and(eq(questionState.studentId, assessment.studentId), eq(questionState.questionId, g.question.id)));

      const nextWeakness = g.correct ? 0 : num(existingState?.weaknessScore ?? 0) + 1;
      const nextInPool = !g.correct;

      await tx
        .insert(questionState)
        .values({
          studentId: assessment.studentId,
          questionId: g.question.id,
          timesSeen: 1,
          timesCorrect: g.correct ? 1 : 0,
          lastSeenAt: submittedAt,
          inRevisionPool: nextInPool,
          weaknessScore: String(nextWeakness),
        })
        .onConflictDoUpdate({
          target: [questionState.studentId, questionState.questionId],
          set: {
            timesSeen: sql`${questionState.timesSeen} + 1`,
            timesCorrect: sql`${questionState.timesCorrect} + ${g.correct ? 1 : 0}`,
            lastSeenAt: submittedAt,
            inRevisionPool: nextInPool,
            weaknessScore: String(nextWeakness),
          },
        });
    }

    await tx.insert(assessmentResults).values({
      assessmentId: assessment.id,
      score: String(score),
      perSubtopic,
      perConcept,
      predictionError: String(predictionError),
      answers: graded.map((g) => ({
        question_id: g.question.id,
        subtopic_id: g.question.subtopicId,
        concept_id: g.question.conceptId,
        chosen_index: g.answer.chosen_index,
        correct_index: g.question.correctIndex,
        correct: g.correct,
      })),
      submittedAt,
    });

    await tx.update(assessments).set({ submittedAt }).where(eq(assessments.id, assessment.id));
  });

  const output: ToolOutput<"qbank.submit_answers"> = {
    assessment_id: assessment.id,
    score,
    per_subtopic: perSubtopic,
    per_concept: perConcept,
    prediction_error: predictionError,
    significant,
    submitted_at: submittedAt.toISOString(),
    revision_pool_additions: newly_weak_questions,
    cleared_questions,
    ...(await reviewSourcesFor(graded.filter((g) => !g.correct).map((g) => g.question))),
  };

  if (input.idempotency_key) {
    await db
      .insert(idempotencyKeys)
      .values({ key: input.idempotency_key, endpoint: "qbank.submit_answers", response: output })
      .onConflictDoNothing();
  }

  if (droppedIds.length > 0) {
    // Not fatal — logged by the caller via the dispatcher's output_summary, not thrown.
  }

  return output;
}

export async function getRevisionPool(
  input: ToolInput<"qbank.get_revision_pool">,
): Promise<ToolOutput<"qbank.get_revision_pool">> {
  const conditions = [eq(questionState.studentId, input.student_id), eq(questionState.inRevisionPool, true)];

  const rows = await db
    .select({ state: questionState, question: questions })
    .from(questionState)
    .innerJoin(questions, eq(questions.id, questionState.questionId))
    .where(and(...conditions, ...(input.subtopic_id ? [eq(questions.subtopicId, input.subtopic_id)] : [])))
    .orderBy(sql`${questionState.weaknessScore} desc`);

  return rows.map((r) => ({
    question_id: r.question.id,
    subtopic_id: r.question.subtopicId,
    weakness_score: num(r.state.weaknessScore),
    stem: r.question.stem,
    options: r.question.options as string[],
  }));
}
