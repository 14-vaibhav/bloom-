/**
 * Question-level weakness tracking (§7). The revision pool has one entry
 * rule (first wrong answer) and one exit rule (two consecutive correct
 * answers on separate calendar days) — nothing else moves it, not mastery,
 * not time passing on its own.
 */

import { WEAKNESS } from "./constants.js";
import type { QuestionState } from "./types.js";
import { daysBetween, isDifferentCalendarDay } from "./util.js";

export function recordQuestionAttempt(state: QuestionState, correct: boolean, now: Date): QuestionState {
  const timesAttempted = state.times_attempted + 1;
  const timesCorrect = state.times_correct + (correct ? 1 : 0);

  if (!correct) {
    return {
      ...state,
      times_attempted: timesAttempted,
      times_correct: timesCorrect,
      consecutive_incorrect: state.consecutive_incorrect + 1,
      consecutive_correct: 0,
      correct_streak_started_at: null,
      last_attempt_at: now,
      in_revision_pool: true,
    };
  }

  const streakStartedAt = state.consecutive_correct > 0 && state.correct_streak_started_at ? state.correct_streak_started_at : now;
  const consecutiveCorrect = state.consecutive_correct + 1;
  const spansSeparateDays = consecutiveCorrect >= 2 && isDifferentCalendarDay(streakStartedAt, now);

  return {
    ...state,
    times_attempted: timesAttempted,
    times_correct: timesCorrect,
    consecutive_incorrect: 0,
    consecutive_correct: consecutiveCorrect,
    correct_streak_started_at: streakStartedAt,
    last_attempt_at: now,
    in_revision_pool: spansSeparateDays ? false : state.in_revision_pool,
  };
}

function recencyWeight(daysSinceLastAttempt: number): number {
  return (
    WEAKNESS.recency_weight_floor +
    WEAKNESS.recency_weight_range * Math.exp(-Math.max(0, daysSinceLastAttempt) / WEAKNESS.recency_halflife_days)
  );
}

export function getWeaknessScore(state: QuestionState, now: Date): number {
  if (state.times_attempted === 0) return 0;

  const errorRate = 1 - state.times_correct / state.times_attempted;
  const incorrectPenalty = 1 + WEAKNESS.consecutive_incorrect_penalty * state.consecutive_incorrect;
  const daysSince = state.last_attempt_at ? daysBetween(state.last_attempt_at, now) : 0;

  return errorRate * incorrectPenalty * recencyWeight(daysSince);
}
