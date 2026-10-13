/**
 * Shared types for the Phase 3 belief/decay/recall/weakness modules. Every
 * function in src/core is pure: state in, state (or a decision) out, time
 * passed as a parameter. Nothing here is a DB row shape — Phase 6 maps
 * to/from these at the persistence boundary.
 */

export type Difficulty = 1 | 2 | 3 | 4 | 5;

export type Format = "video" | "article" | "practice" | "doc" | "course";

export type FormatEfficacy = Record<Format, number>;

export type SubtopicBelief = {
  subtopic_id: string;
  mu: number; // 0..1 point estimate of mastery
  confidence: number; // 0..1 — how much we trust mu
  learn_rate: number; // mastery gained per hour of study
  evidence_count: number;
  assessment_count: number; // distinct assessments, not questions
  last_observed_at: Date | null;
  mu_at_last_observation: number;
  hours_since_last_observation: number;
  prediction_error_ema: number;
  format_efficacy: FormatEfficacy;
  retention_estimate: number;
  strength_days: number;
};

export type Observation = {
  source_id: string; // assessment or activity id — the idempotency key
  n: number; // number of questions this observation is based on
  difficulty: Difficulty;
  score: number; // 0..1, raw (pre difficulty-adjustment)
  predicted_score?: number; // the assessment's predicted_score, same raw scale
  format_hours?: Partial<Record<Format, number>>; // hours studied per format since last observation
};

export type BeliefDelta = {
  applied: boolean; // false when the observation was a duplicate (see appliedSourceIds)
  mu_before: number;
  mu_after: number;
  confidence_before: number;
  confidence_after: number;
  learn_rate_before: number;
  learn_rate_after: number;
  prediction_error?: number;
  significant: boolean; // |prediction_error| > BELIEF.prediction_error_threshold
};

export type RecallReason = "scheduled_interval" | "retention_decay" | "recall_failure";

export type RecallProposal = {
  subtopic_id: string;
  due_at: Date;
  urgency: number; // 0..1
  reason: RecallReason;
  suggested_duration_min: number;
  interval_index: number;
};

export type QuestionState = {
  student_id: string;
  question_id: string;
  times_attempted: number;
  times_correct: number;
  consecutive_incorrect: number;
  consecutive_correct: number;
  correct_streak_started_at: Date | null; // calendar day the current correct streak began
  last_attempt_at: Date | null;
  in_revision_pool: boolean;
};

export type ConceptAttempt = {
  correct: boolean;
  at: Date;
};

export type ConceptWeakness = {
  concept: string;
  subtopic_id: string;
  accuracy: number; // across all attempts on this concept
  attempts: number;
  consecutive_failures: number;
  severity: number;
  is_repeated: boolean; // >= 3 attempts, accuracy < 0.5
  is_forgotten: boolean; // was >= 0.7, now < 0.5
};

export type MasteryBadgeLevel = "green" | "amber" | "grey";

export type MasteryBadgeResult = {
  level: MasteryBadgeLevel;
  reasons: string[]; // failing sub-conditions, human-readable; empty for green
};

// ────────────────────────────────────────────────────────────────
// Phase 4 — gap engine, action selection, resource fit, slotter, planner.
// See bloom-phase4-brief.md. Everything below stays pure: no DB shapes.
// ────────────────────────────────────────────────────────────────

/**
 * The seven actions §4.1 defines, plus MILESTONE — the planner's own
 * multi-subtopic checkpoint (§7.7.4e), which the action selector never
 * produces and which Phase 6 is free to persist however its schema allows
 * (e.g. an `assessments` row with no matching `learning_activities` row).
 */
export type ActionType = "LEARN" | "PRACTICE" | "IMMEDIATE_TEST" | "ACTIVE_RECALL" | "REVISION" | "FINAL_TEST" | "NONE" | "MILESTONE";

/** One subtopic's ranking inputs, already resolved by the caller from belief + blueprint + topic graph. */
export type GapEngineInput = {
  subtopic_id: string;
  mu: number;
  confidence: number;
  learn_rate: number;
  target_mastery: number;
  blueprint_weight: number;
  retention_estimate: number;
  unmastered_dependent_count: number; // # subtopics gated on this one that aren't mastered yet
  days_until_needed: number; // deadline - remaining_topological_depth * avg_days_per_subtopic
  // action-selector inputs, carried alongside so buildGapTable can attach `action` in one pass
  evidence_count: number;
  has_completed_learning: boolean; // at least one LEARN activity for this subtopic reached `completed`
  is_repeated_weakness: boolean; // ConceptWeakness.is_repeated, rolled up to the subtopic
  all_learn_practice_complete: boolean;
  has_final_test: boolean;
};

/** Raw, pre-normalisation factors — safe to store as a historical snapshot (§3.2: priority itself is not). */
export type GapFactors = {
  gap: number;
  severity: number;
  blocking_term: number;
  urgency: number;
  learnability: number;
  uncertainty: number;
  retention_risk: number;
};

export type GapEntry = {
  subtopic_id: string;
  priority: number; // 0..100, relative to the current candidate set only — never compare across plan versions
  action: ActionType;
  gap_snapshot: GapFactors;
};

export type ActionSelectorInput = {
  evidence_count: number;
  confidence: number;
  blueprint_weight: number;
  has_completed_learning: boolean;
  retention_estimate: number;
  target_mastery: number;
  is_repeated_weakness: boolean;
  mu: number;
  all_learn_practice_complete: boolean;
  has_final_test: boolean;
};

export type ResourceCandidate = {
  id: string;
  type: Format;
  difficulty: Difficulty;
  duration_min: number;
  quality: number; // 0..1
  blacklisted: boolean;
  already_consumed: boolean;
  covers_focus_concept: boolean;
};

export type ResourceFitBreakdown = {
  level_match: number;
  duration_fit: number;
  quality: number;
  format_match: number;
  novelty: number;
  concept_hit: number;
};

export type ScoredResource = {
  resource_id: string;
  fit: number; // 0..1
  breakdown: ResourceFitBreakdown;
};

export type WeeklyAvailability = Record<string, Array<{ start: string; end: string }>>;

export type StudentConstraintsInput = {
  weekly_availability: WeeklyAvailability;
  max_daily_study_min: number;
  min_session_min: number;
  max_session_min: number;
  blackout_dates: string[]; // "YYYY-MM-DD"
};

export type BusyInterval = { start: Date; end: Date };

export type Slot = {
  start: Date;
  end: Date;
  duration_min: number;
  energy_weight: number;
};

export type DegradedSignal = "SUBSTITUTE_ACTIVITY_TYPE" | "PROVISIONAL_PLAN" | "DEFER_ASSESSMENTS" | "REDUCED_CONFIDENCE";

export type LearningGoal = {
  subject_id: string;
  deadline: Date;
  blueprint: Record<string, number>; // subtopic_id -> weight, confirmed by the student
  target_mastery: Record<string, number>; // subtopic_id -> target
  must_have_subtopics: string[];
};

/** Subtopic prerequisite graph plus the per-subtopic scheduling metadata the planner needs. */
export type TopicGraph = {
  subtopic_ids: string[];
  prerequisites: Array<{ subtopic_id: string; prereq_id: string }>; // subtopic_id depends on prereq_id
  base_hours: Record<string, number>;
};

export type Activity = {
  subtopic_id: string;
  resource_id: string | null;
  action: ActionType;
  start: Date;
  end: Date;
  duration_min: number;
  priority: number | null;
  predicted_score: number;
  expected_mastery_after: number;
  provisional: boolean;
};

export type PlanProjection = {
  projected_mastery_at_deadline: Record<string, number>;
  projected_goal_attainment: number; // 0..1
  deficit_hours: number; // total_needed - total_available; > 0 is not fatal here, Phase 5 judges it
  unplaced_hours: Record<string, number>; // subtopic_id -> hours the greedy fill could not place
};

export type Plan = {
  activities: Activity[];
  projection: PlanProjection;
  degraded_tools: DegradedSignal[];
};

// ────────────────────────────────────────────────────────────────
// Phase 5 — assessment composer, scorer, validator, repair, negotiation.
// See bloom-phase5-brief.md. Still pure: no DB, no clock, no tool calls.
// ────────────────────────────────────────────────────────────────

export type AssessmentPurpose = "diagnostic" | "immediate" | "active_recall" | "retest" | "final";

/** One question as the composer sees it — enough to sort, predict, and pick from a pool. */
export type QuestionCandidate = {
  question_id: string;
  concept_id: string | null;
  difficulty: Difficulty;
  weakness_score: number; // 0 for never-attempted questions
};

export type ComposerInput = {
  purpose: AssessmentPurpose;
  mu: number; // current subtopic mastery — drives the "new" predictor
  concept_accuracy: Record<string, number>; // concept_id -> accuracy — drives the "targeted" predictor
  new_pool: QuestionCandidate[]; // never attempted by this student, this subtopic
  correct_pool: QuestionCandidate[]; // previously answered correctly — active_recall's retrieval slots
  revision_pool: QuestionCandidate[]; // in_revision_pool for this subtopic, any weakness_score
  targeted_pool: QuestionCandidate[]; // candidates from the lowest-accuracy concept, caller-scoped
};

export type ComposedAssessment = {
  question_ids: string[];
  composition: { new: number; revision: number; targeted: number; correct: number };
  predicted_score: number;
  note: string | null; // set when the actual composition departed from the ideal shape
};

export type AnswerRecord = { question_id: string; chosen_index: number };

/** The question-bank metadata scoreAssessment needs — a subset of the `questions` row plus
 * whether this question was drawn from the revision pool for this attempt (drives
 * `cleared_questions`; a correct answer that entered fresh has nothing to clear). */
export type QuestionMeta = {
  question_id: string;
  subtopic_id: string;
  concept_id: string | null;
  difficulty: Difficulty;
  correct_index: number;
  was_in_revision_pool?: boolean;
};

export type ScorerInput = {
  predicted_score: number; // assessments.predicted_score, written at composition — never recomputed
  answers: AnswerRecord[];
  questions: QuestionMeta[]; // metadata for every question_id referenced in `answers`
};

export type ScoredAssessment = {
  score: number;
  per_subtopic: Record<string, number>;
  per_concept: Record<string, { correct: number; total: number; accuracy: number }>;
  per_difficulty: Partial<Record<Difficulty, number>>; // accuracy, only for difficulties present
  predicted_score: number;
  prediction_error: number;
  significant: boolean;
  newly_weak_questions: string[]; // answered incorrectly this attempt
  cleared_questions: string[]; // was_in_revision_pool && answered correctly this attempt
};

export type ScoreResult = { ok: true; result: ScoredAssessment } | { ok: false; error: string };

// ---- validator ----------------------------------------------------------

export type CheckId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "L1" | "L2" | "L3" | "L4" | "L5";
export type CheckStatus = "pass" | "fail" | "warn";
export type Route = "commit" | "repair" | "negotiate";

export type CheckResult = {
  id: CheckId;
  name: string;
  status: CheckStatus;
  detail?: string;
  /** Composite refs, not DB ids — Activity has no id pre-persistence. Format:
   * `${subtopic_id}:${action}:${start.toISOString()}`. Phase 6 remaps to real ids at commit. */
  offending_activity_ids?: string[];
  suggested_operator?: RepairOperatorName;
};

export type ValidationReport = {
  valid: boolean;
  hard_failures: number;
  soft_warnings: number;
  repair_round: number;
  checks: CheckResult[];
  route: Route;
};

export type ValidatorState = {
  beliefs: SubtopicBelief[];
  topicGraph: TopicGraph;
  goal: LearningGoal;
  gapTable: GapEntry[];
  externalEvents: BusyInterval[];
  /** resource_id -> the resource's own duration_min, for C4. Missing/unknown resource_ids
   * are skipped, not failed — the validator can't fail a check it has no data for. */
  resourceDurations: Record<string, number>;
  /** subtopic_id -> ACTIVE_RECALL count already completed before this plan, for L2. */
  completedActiveRecallCounts: Record<string, number>;
};

// ---- repair ---------------------------------------------------------------

export type RepairOperatorName = "SHIFT" | "SPLIT" | "SWAP" | "SUBSTITUTE" | "COMPRESS" | "DEFER" | "NEGOTIATE";

export type RepairLogEntry = {
  round: number;
  operator: RepairOperatorName;
  check_id: CheckId;
  detail: string;
};

export type RepairContext = {
  validatorState: ValidatorState;
  constraints: StudentConstraintsInput;
};

export type RepairResult = {
  plan: Plan;
  rounds: number;
  log: RepairLogEntry[];
  finalReport: ValidationReport;
  route: Route; // "commit" once passing, "negotiate" once exhausted/routed there
};

// ---- negotiation ------------------------------------------------------------

export type NegotiationOptionLabel = "A" | "B" | "C";

export type NegotiationOption = {
  label: NegotiationOptionLabel;
  description: string;
  cost: number;
};

export type DropCandidate = { subtopic_id: string; weight: number; hours_needed: number };

export type NegotiateInput = {
  required_hours: number;
  available_hours: number;
  days_remaining: number;
  must_have_subtopics: string[];
  drop_candidates: DropCandidate[]; // lowest-priority-first, non-must-have
  plan: Plan;
};

export type NegotiationResult = {
  infeasible: true;
  deficit_hours: number;
  best_partial_plan: Plan;
  protected_subtopics: string[];
  protected_weight: number;
  deferred_subtopics: string[];
  projected_attainment: number;
  options: NegotiationOption[];
  recommended: NegotiationOptionLabel;
  recommendation_reason: string;
};

// ---- defect injection -------------------------------------------------------

export type DefectType = "overlap" | "deadline" | "missing_final" | "prereq" | "capacity";
