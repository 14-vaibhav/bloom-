/**
 * Builds each assessment from the right mix of questions (bloom-phase5-brief
 * §3). Composition is a lookup by purpose (§3.1), except `final`, whose
 * revision/targeted slots scale to the actual pool per §3.2 — PRD v3's fixed
 * "6 new + 2 revision + 2 targeted" can't hold four wrong answers, and the
 * project's own acceptance test requires exactly that.
 *
 * predicted_score uses three different estimators (§3.3) because unseen,
 * revision-pool, and concept-targeted questions are three different
 * populations. Using `mu` for a revision question would over-predict — the
 * student already failed it once — and that bias would propagate into every
 * downstream prediction-error trigger.
 *
 * Selection is fully deterministic: sort each pool by (weakness_score desc,
 * question_id asc) and take from the top. No Math.random — Phase 9's eval
 * harness needs reproducible runs.
 */

import { COMPOSER } from "./constants.js";
import type { AssessmentPurpose, ComposedAssessment, ComposerInput, QuestionCandidate } from "./types.js";
import { clamp } from "./util.js";

function sortPool(pool: QuestionCandidate[]): QuestionCandidate[] {
  return [...pool].sort((a, b) => b.weakness_score - a.weakness_score || a.question_id.localeCompare(b.question_id));
}

function take(pool: QuestionCandidate[], count: number, exclude: ReadonlySet<string>): QuestionCandidate[] {
  const picked: QuestionCandidate[] = [];
  for (const q of pool) {
    if (picked.length >= count) break;
    if (exclude.has(q.question_id)) continue;
    picked.push(q);
  }
  return picked;
}

/** §3.2's adaptive final-test formula. Caps at the brief's exact numbers: at most 4
 * revision, MIN_NEW never fewer than 5, targeted takes whatever's left after that. */
function finalShape(revisionPoolSize: number): { new: number; revision: number; targeted: number } {
  const revision = Math.min(4, revisionPoolSize);
  const targeted = Math.min(2, 10 - revision - COMPOSER.min_new_final);
  const newCount = 10 - revision - targeted;
  return { new: newCount, revision, targeted };
}

function idealShape(
  purpose: AssessmentPurpose,
  revisionPoolSize: number,
): { total: number; new: number; revision: number; targeted: number; correct: number } {
  if (purpose === "final") {
    const { new: n, revision, targeted } = finalShape(revisionPoolSize);
    return { total: 10, new: n, revision, targeted, correct: 0 };
  }
  if (purpose === "retest") {
    const revision = Math.min(4, revisionPoolSize);
    return { total: 8, new: 8 - revision, revision, targeted: 0, correct: 0 };
  }
  const s = COMPOSER.shapes[purpose];
  return { total: s.total, new: s.new, revision: s.revision, targeted: s.targeted, correct: s.correct };
}

function predictUnseen(mu: number, difficulty: number): number {
  const p = mu - COMPOSER.unseen_difficulty_slope * (difficulty - 3) / 2;
  return clamp(p, COMPOSER.predicted_score_floor, COMPOSER.predicted_score_ceiling);
}

function predictRevision(mu: number): number {
  return clamp(mu * COMPOSER.revision_predictor_factor, COMPOSER.predicted_score_floor, COMPOSER.predicted_score_ceiling);
}

function predictTargeted(conceptAccuracy: Record<string, number>, conceptId: string | null, mu: number): number {
  const acc = conceptId !== null ? conceptAccuracy[conceptId] : undefined;
  return clamp(acc ?? mu, COMPOSER.predicted_score_floor, COMPOSER.predicted_score_ceiling);
}

export function composeAssessment(input: ComposerInput): ComposedAssessment {
  const ideal = idealShape(input.purpose, input.revision_pool.length);
  const selected = new Set<string>();
  const notes: string[] = [];

  const revisionPicked = take(sortPool(input.revision_pool), ideal.revision, selected);
  revisionPicked.forEach((q) => selected.add(q.question_id));

  const targetedPicked = take(sortPool(input.targeted_pool), ideal.targeted, selected);
  targetedPicked.forEach((q) => selected.add(q.question_id));

  const correctPicked = take(sortPool(input.correct_pool), ideal.correct, selected);
  correctPicked.forEach((q) => selected.add(q.question_id));

  // Backfill shortfalls from the new pool first (§3.4: "never return a short assessment"),
  // then top up to the ideal `new` count on top of that.
  const shortfall =
    (ideal.revision - revisionPicked.length) + (ideal.targeted - targetedPicked.length) + (ideal.correct - correctPicked.length);
  const newTarget = ideal.new + Math.max(0, shortfall);
  const newPicked = take(sortPool(input.new_pool), newTarget, selected);
  newPicked.forEach((q) => selected.add(q.question_id));

  const actual = { new: newPicked.length, revision: revisionPicked.length, targeted: targetedPicked.length, correct: correctPicked.length };
  const actualTotal = actual.new + actual.revision + actual.targeted + actual.correct;

  // Departure #1: the adaptive shape itself differs from the nominal (full-pool) shape —
  // i.e. the revision pool was smaller than the 4 the nominal shape assumes.
  const nominal = COMPOSER.shapes[input.purpose];
  if (ideal.revision !== nominal.revision || ideal.targeted !== nominal.targeted || ideal.new !== nominal.new) {
    notes.push(
      `revision pool held ${input.revision_pool.length} question(s) — composed ${ideal.revision} revision + ${ideal.targeted} targeted + ${ideal.new} new ` +
        `(nominal is ${nominal.revision}/${nominal.targeted}/${nominal.new}).`,
    );
  }
  // Departure #2: even the adaptive shape couldn't be filled — targeted/correct/new pools
  // were themselves too small, so we backfilled from new (§3.4) or fell short entirely.
  if (actual.new !== ideal.new || actual.revision !== ideal.revision || actual.targeted !== ideal.targeted || actual.correct !== ideal.correct) {
    notes.push(
      `pool exhaustion — composed ${actual.revision}/${actual.targeted}/${actual.correct}/${actual.new} (revision/targeted/correct/new) against an adaptive target of ${ideal.revision}/${ideal.targeted}/${ideal.correct}/${ideal.new}.`,
    );
  }
  if (actualTotal < ideal.total) {
    notes.push(`short assessment: composed ${actualTotal} of the ideal ${ideal.total} — new pool exhausted too.`);
  }

  const predictions = [
    ...revisionPicked.map((q) => predictRevision(input.mu)),
    ...targetedPicked.map((q) => predictTargeted(input.concept_accuracy, q.concept_id, input.mu)),
    ...correctPicked.map((q) => predictUnseen(input.mu, q.difficulty)), // retrieval of known material — same estimator as unseen, no failure/concept signal applies
    ...newPicked.map((q) => predictUnseen(input.mu, q.difficulty)),
  ];
  const predictedScore = predictions.length > 0 ? predictions.reduce((s, p) => s + p, 0) / predictions.length : 0;

  const questionIds = [...revisionPicked, ...targetedPicked, ...correctPicked, ...newPicked].map((q) => q.question_id);

  return {
    question_ids: questionIds,
    composition: actual,
    predicted_score: predictedScore,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}
