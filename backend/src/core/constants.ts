/**
 * Every tuned number in Phase 3 lives here, and nowhere else in src/core.
 * When the eval harness (Phase 9) says the model is miscalibrated or too
 * twitchy, this is the one file that changes.
 */

export const BELIEF = {
  // how much a question at each difficulty tells us
  difficulty_reliability: { 1: 0.7, 2: 0.85, 3: 1.0, 4: 1.1, 5: 1.2 },
  // scoring adjustment — 70% on hard questions means more than 70% on easy ones
  difficulty_factor: { 1: 0.85, 2: 0.92, 3: 1.0, 4: 1.10, 5: 1.18 },
  alpha_base: 0.15, // minimum learning rate of the estimator
  alpha_uncertainty: 0.45, // extra responsiveness when confidence is low
  evidence_saturation: 8, // questions needed for full evidence weight
  confidence_gain: 0.5, // how fast confidence accumulates per unit evidence
  confidence_decay_daily: 0.97,
  learn_rate_bounds: [0.02, 0.35] as [number, number],
  prediction_error_threshold: 0.15,
  prediction_error_ema_alpha: 0.3,
  min_hours_for_recalibration: 0.5,
  recalibration_damping: 0.5, // the "0.5 + 0.5 * ratio" shape
  format_efficacy_ema_alpha: 0.3,
  min_format_hours: 0.25,
  min_predicted_gain: 0.01,
} as const;

export const RECALL = {
  base_intervals_days: [3, 10],
  multiplier_strong: 2.0, // recall >= 0.85
  multiplier_ok: 1.0, // 0.5 - 0.85
  multiplier_weak: 0.4, // < 0.5
  strong_threshold: 0.85,
  ok_threshold: 0.5,
  max_interval_days: 21,
  strength_base: 3,
  strength_scale: 12,
  retention_trigger_ratio: 0.8, // fires when retention < target * 0.8
  min_blueprint_weight_for_recall: 0.05,
  default_recall_duration_min: 15,
  default_revision_duration_min: 20,
  urgency_scheduled: 0.5,
  urgency_scheduled_after_weak_recall: 0.8,
  urgency_recall_failure: 0.9,
  urgency_retention_decay: 0.85,
} as const;

export const MASTERY_BADGE = {
  min_mu_ratio: 1.0, // mu >= target
  min_confidence: 0.70,
  min_assessments: 2,
  max_staleness_days: 14,
} as const;

export const WEAKNESS = {
  recency_halflife_days: 14,
  consecutive_incorrect_penalty: 0.5,
  recency_weight_floor: 0.5,
  recency_weight_range: 0.5,
} as const;

export const CONCEPT = {
  severity_attempts_saturation: 5,
  repeated_min_attempts: 3,
  repeated_max_accuracy: 0.5,
  forgotten_prior_min_accuracy: 0.7,
  forgotten_recent_max_accuracy: 0.5,
  forgotten_recent_window: 3,
  forgotten_min_prior_attempts: 2,
} as const;

// Phase 4 — gap engine (bloom-phase4-brief §3.2, correcting PRD v3's unnormalised weighting)
export const GAP = {
  blocking_factor_per_dependent: 0.4,
  uncertainty_scale: 0.25,
  urgency_days_scale: 7, // urgency = 1 / (1 + days_until_needed / 7)
  min_max_epsilon: 1e-9, // below this range, a factor carries no signal — normalise to 0.5
  weights: {
    severity: 0.35,
    blocking: 0.15,
    urgency: 0.15,
    learnability: 0.08,
    uncertainty: 0.10,
    retention_risk: 0.17,
  },
} as const;

// Phase 4 — action selector (bloom-phase4-brief §4.2, correcting PRD v3's rule ordering)
export const ACTION = {
  immediate_test_min_evidence: 1,
  immediate_test_max_evidence: 5, // exclusive upper bound
  immediate_test_max_confidence: 0.40,
  immediate_test_min_blueprint_weight: 0.10,
} as const;

// Phase 4 — resource fit (bloom-phase4-brief §5.1)
export const RESOURCE_FIT = {
  zpd_offset: 0.15, // just-above-current-mastery target for level_match
  duration_soft_cap_ratio: 0.9, // a resource fits "for free" up to 90% of the slot
  novelty_consumed: 0.2,
  novelty_blacklisted: 0,
  novelty_fresh: 1,
  concept_hit_match: 1,
  concept_hit_default: 0.5,
  weights: {
    level_match: 0.25,
    duration_fit: 0.20,
    quality: 0.15,
    format_match: 0.15,
    novelty: 0.10,
    concept_hit: 0.15,
  },
} as const;

// Phase 4 — slotter (bloom-phase4-brief §6)
export const SLOT = {
  split_gap_min: 10, // gap left between two sessions carved from one split fragment
  default_energy_weight: 1.0,
} as const;

// Phase 4 — planner (bloom-phase4-brief §7)
export const PLANNER = {
  min_hours_per_subtopic: 0.5,
  max_hours_multiplier: 1.5, // clamp of hours_needed against base_hours * this
  immediate_test_duration_min: 10,
  final_test_duration_min_range: [15, 20] as [number, number],
  milestone_duration_min: 25,
  milestone_interval_days: 7,
  milestone_top_n_subtopics: 3,
  max_predicted_score: 0.98,
  fill_loop_guard: 100,
} as const;

// Phase 5 — assessment composer (bloom-phase5-brief §3)
export const COMPOSER = {
  // { total, new, revision (cap), targeted (cap), correct } per purpose. revision/targeted
  // for "final" are caps only — composer.ts computes the adaptive split at request time.
  shapes: {
    diagnostic: { total: 15, new: 15, revision: 0, targeted: 0, correct: 0 },
    immediate: { total: 8, new: 8, revision: 0, targeted: 0, correct: 0 },
    active_recall: { total: 5, new: 3, revision: 0, targeted: 0, correct: 2 },
    retest: { total: 8, new: 4, revision: 4, targeted: 0, correct: 0 },
    final: { total: 10, new: 5, revision: 4, targeted: 1, correct: 0 }, // nominal (full pool); adaptive when the revision pool is smaller
  },
  min_new_final: 5,
  revision_predictor_factor: 0.70, // predicted p for a revision-pool question = mu * this
  unseen_difficulty_slope: 0.15, // predicted p for an unseen question = mu - slope*(difficulty-3)/2
  predicted_score_floor: 0.02,
  predicted_score_ceiling: 0.98,
} as const;

// Phase 5 — validator (bloom-phase5-brief §5). Deliberately its own numbers, not imports
// from PLANNER/SLOT — see validator.ts header on independence from the planner.
export const VALIDATOR = {
  resource_duration_buffer_min: 5, // C4
  mastered_prereq_ratio: 0.7, // C5: prereq clears if mu >= target * this
  low_mastery_threshold: 0.5, // L3
  min_active_recall_for_completed: 2, // L2
  top_gap_count: 3, // L1
  practice_assessment_min_ratio: 0.3, // L4, soft
} as const;

// Phase 5 — repair (bloom-phase5-brief §6)
export const REPAIR = {
  max_rounds: 3,
  compress_ratio: 0.6, // COMPRESS: new duration = old * this
  split_ratio: 0.5, // SPLIT: each half = old * this
} as const;

// Phase 5 — negotiation (bloom-phase5-brief §7). Cost-index divisors from the corrected
// worked example in §7.3 — do not "round" these, the demo line does the arithmetic live.
export const NEGOTIATE = {
  cost_a_days_divisor: 7, // a week of slip = 1.0
  cost_c_weight_divisor: 0.10, // losing 10% of the goal = 1.0
} as const;
