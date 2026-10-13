import type { QuestionState, SubtopicBelief } from "../../src/core/types.js";

export function makeBelief(overrides: Partial<SubtopicBelief> = {}): SubtopicBelief {
  return {
    subtopic_id: "arr_traversal",
    mu: 0.5,
    confidence: 0.3,
    learn_rate: 0.1,
    evidence_count: 0,
    assessment_count: 0,
    last_observed_at: null,
    mu_at_last_observation: 0.5,
    hours_since_last_observation: 0,
    prediction_error_ema: 0,
    format_efficacy: { video: 0.1, article: 0.1, practice: 0.1, doc: 0.1, course: 0.1 },
    retention_estimate: 0.5,
    strength_days: 3,
    ...overrides,
  };
}

export function makeQuestionState(overrides: Partial<QuestionState> = {}): QuestionState {
  return {
    student_id: "s1",
    question_id: "q1",
    times_attempted: 0,
    times_correct: 0,
    consecutive_incorrect: 0,
    consecutive_correct: 0,
    correct_streak_started_at: null,
    last_attempt_at: null,
    in_revision_pool: false,
    ...overrides,
  };
}
