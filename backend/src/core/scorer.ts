/**
 * Grades a submitted assessment (bloom-phase5-brief §4). Pure: given the
 * predicted_score written at composition time, the answers, and question
 * metadata, produces the breakdown. It does not touch subtopic_mastery or
 * question_state — Phase 6 (qbank.ts) persists; belief.ts (Phase 3) owns
 * the model update.
 *
 * `predicted_score` is never recomputed here — it's read straight through.
 * That's the whole point: the prediction was locked in before the student
 * answered, and prediction_error only means something if nothing after
 * composition time can move it.
 */

import { BELIEF } from "./constants.js";
import type { QuestionMeta, ScorerInput, ScoreResult } from "./types.js";

export function scoreAssessment(input: ScorerInput): ScoreResult {
  if (input.answers.length === 0) {
    return { ok: false, error: "No answers submitted." };
  }

  const questionById = new Map(input.questions.map((q) => [q.question_id, q]));
  const unknown = input.answers.filter((a) => !questionById.has(a.question_id));
  if (unknown.length > 0) {
    return { ok: false, error: `No metadata for questions: ${unknown.map((a) => a.question_id).join(", ")}` };
  }

  const graded = input.answers.map((a) => {
    const q = questionById.get(a.question_id) as QuestionMeta;
    return { answer: a, question: q, correct: a.chosen_index === q.correct_index };
  });

  const total = graded.length;
  const correctCount = graded.filter((g) => g.correct).length;
  const score = correctCount / total;

  const perSubtopicAgg = new Map<string, { correct: number; total: number }>();
  const perConceptAgg = new Map<string, { correct: number; total: number }>();
  const perDifficultyAgg = new Map<number, { correct: number; total: number }>();

  for (const g of graded) {
    const st = perSubtopicAgg.get(g.question.subtopic_id) ?? { correct: 0, total: 0 };
    st.total += 1;
    if (g.correct) st.correct += 1;
    perSubtopicAgg.set(g.question.subtopic_id, st);

    if (g.question.concept_id) {
      const c = perConceptAgg.get(g.question.concept_id) ?? { correct: 0, total: 0 };
      c.total += 1;
      if (g.correct) c.correct += 1;
      perConceptAgg.set(g.question.concept_id, c);
    }

    const d = perDifficultyAgg.get(g.question.difficulty) ?? { correct: 0, total: 0 };
    d.total += 1;
    if (g.correct) d.correct += 1;
    perDifficultyAgg.set(g.question.difficulty, d);
  }

  const perSubtopic = Object.fromEntries([...perSubtopicAgg].map(([k, v]) => [k, v.correct / v.total]));
  const perConcept = Object.fromEntries([...perConceptAgg].map(([k, v]) => [k, { correct: v.correct, total: v.total, accuracy: v.correct / v.total }]));
  const perDifficulty = Object.fromEntries([...perDifficultyAgg].map(([k, v]) => [k, v.correct / v.total]));

  const predictionError = score - input.predicted_score;
  const significant = Math.abs(predictionError) > BELIEF.prediction_error_threshold;

  const newlyWeak = graded.filter((g) => !g.correct).map((g) => g.question.question_id);
  const cleared = graded.filter((g) => g.correct && g.question.was_in_revision_pool).map((g) => g.question.question_id);

  return {
    ok: true,
    result: {
      score,
      per_subtopic: perSubtopic,
      per_concept: perConcept,
      per_difficulty: perDifficulty,
      predicted_score: input.predicted_score,
      prediction_error: predictionError,
      significant,
      newly_weak_questions: newlyWeak,
      cleared_questions: cleared,
    },
  };
}
