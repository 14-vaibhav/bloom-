export type Subject = { id: string; name: string; description: string; icon: string; topic_count: number; has_course_material?: boolean };

export type SubtopicNode = { id: string; name: string; weight: number; base_hours: number; difficulty: number; description: string | null };
export type TopicNode = { id: string; name: string; weight: number; base_hours: number; difficulty: number; subtopics: SubtopicNode[] };
export type SubjectTree = {
  id: string; name: string; topics: TopicNode[];
  topic_prerequisites: Array<{ topic_id: string; prereq_id: string; strength: number }>;
  subtopic_prerequisites: Array<{ subtopic_id: string; prereq_id: string; strength: number }>;
};

export type Student = { id: string; name: string; email: string };

export type ActivityResource = { title: string; url: string; type: string; source_id: string | null; locator_range: Record<string, number> | null };

export type Activity = {
  resource?: ActivityResource | null;
  activity_id: string; subtopic_id: string; resource_id: string | null; action: string;
  scheduled_start: string; scheduled_end: string; duration_min: number; priority: number | null;
  predicted_score: number | null; expected_mastery_after: number | null; status: string; provisional: boolean;
};

export type StudentState = {
  student: { id: string; name: string; email: string; sim_now: string };
  goal: { goal_id: string; subject_id: string; title: string; deadline: string; blueprint: Record<string, number>; target_mastery: Record<string, number>; must_have_subtopics: string[]; status: string } | null;
  constraints: { weekly_availability: Record<string, Array<{ start: string; end: string }>>; max_daily_study_min: number; min_session_min: number; max_session_min: number; blackout_dates: string[]; preferred_formats: string[]; effective_from: string } | null;
  plan: { plan_id: string; current_version: number; upcoming_activities: Activity[] } | null;
  recent_mastery: Array<{ subtopic_id: string; mu: number; confidence: number }>;
};

export type Plan = {
  plan_id: string; version: number; parent_version: number | null; trigger: string; scope: string; reason: string;
  diff: unknown; validation_report: ValidationReport | null; repair_rounds: number; created_at: string; activities: Activity[];
};

export type PlanVersionSummary = { version: number; parent_version: number | null; trigger: string; scope: string; reason: string; repair_rounds: number; created_at: string };

export type PlanDiff = {
  added: Array<{ activity_id: string; subtopic_id: string; action: string; start: string; end: string; resource_id: string | null }>;
  removed: Array<{ activity_id: string; subtopic_id: string; action: string; start: string; end: string; resource_id: string | null }>;
  moved: Array<{ activity: { activity_id: string; subtopic_id: string; action: string; start: string; end: string }; from: string; to: string }>;
  modified: Array<{ activity: { activity_id: string; subtopic_id: string; action: string }; field: string; from: unknown; to: unknown }>;
  unchanged_count: number;
};

export type ValidationReport = { hard_failures: number; route: string; [key: string]: unknown };

export type MasteryTree = {
  subject_id: string;
  topics: Array<{ id: string; name: string; subtopics: Array<{ id: string; name: string; target_mastery: number; mu: number; confidence: number; badge: "green" | "amber" | "grey"; badge_reasons: string[] }> }>;
};

export type DailySummary = {
  date: string; message: string; status?: string;
  signals?: { attendance14d: number | null; trajectory: number | null; bufferDays: number | null; requiredHours: number; availableHours: number };
  primary_cause?: { subtopic_id: string; kind: string; detail: string } | null;
  motivation?: string | null;
  recovery_plan_version?: number | null;
};

export type AgentEvent = {
  id: number; run_id: string; seq: number; phase: string; event_type: string; tool_name: string | null;
  message: string; payload: unknown; error_class: string | null; retry_attempt: number; latency_ms: number | null; created_at: string;
};

export type AgentRun = {
  run_id: string; student_id: string; trigger: string; scope: string; outcome: string | null; status: string;
  degraded_tools: string[]; tool_call_count: number; llm_call_count: number; total_latency_ms: number | null;
  new_plan_version: number | null; started_at: string; ended_at: string | null;
};

export type ToolHealth = { tool: string; state: "closed" | "open" | "half_open"; consecutive_failures: number; opened_at: string | null; last_error: string | null; last_success_at: string | null };

export type AssessmentQuestion = { question_id: string; subtopic_id: string; concept_id: string | null; difficulty: number; stem: string; options: string[] };
export type AssessmentDetail = { assessment_id: string; purpose: string; subtopic_ids: string[]; predicted_score: number; submitted: boolean; questions: AssessmentQuestion[] };
export type AssessmentSubmitResult = {
  score: number; per_topic: Record<string, number>; per_concept: Record<string, { correct: number; total: number; accuracy: number }>;
  predicted_score: number; prediction_error: number; newly_weak_questions: string[]; cleared_questions: string[]; submitted_at: string;
  review_sources?: Record<string, ReviewSource[]>; review_sources_note?: string | null;
};

// ── knowledge base & tutor (v4) ────────────────────────────────────

export type SourceKind = "video" | "slides" | "textbook";

export type ReviewSource = { chunk_id: string; source_id: string; kind: SourceKind; label: string; deep_link: string; own: boolean };

export type KbChunk = {
  chunk_id: string; source_id: string; source_title: string; kind: SourceKind; modality: string;
  locator: Record<string, unknown>; label: string; deep_link: string; asset_url: string | null;
  text: string; visual_description: string | null; subtopic_ids: string[]; score: number;
  prev_id?: string | null; next_id?: string | null;
};

export type KbSource = {
  id: string; subject_id: string; kind: SourceKind; title: string; provider: string | null; url: string | null;
  license: string | null; duration_sec: number | null; unit_count: number | null; ingested_at: string | null;
};

export type KbReport = {
  sources: Array<{ id: string; kind: SourceKind; title: string; license: string | null; chunks: number; tagged: number; untagged: number; low_info: number; ingested_at: string | null; by_modality: Record<string, number> }>;
  coverage: Array<{ subtopic_id: string; name: string; video: number; slides: number; textbook: number; single_source: boolean }>;
};

export type KbOutline = {
  source: { id: string; kind: SourceKind; title: string; chunk_count: number };
  units: Array<{ locator: Record<string, unknown>; heading: string | null; chunk_ids: string[]; subtopic_ids: string[] }>;
};

export type CheckResult = { id: string; severity: "hard" | "soft"; passed: boolean; detail: string };
export type CitationReport = { passed: boolean; checks: CheckResult[]; hard_failures: string[]; soft_warnings: string[] };
export type TutorSegment = { text: string; chunk_ids: string[]; quote: string };
export type TutorOutcome = "answered" | "extractive_fallback" | "declined_no_evidence" | "declined_kb_down";

export type TutorTurn = {
  turn_id: string; session_id: string; asked_at: string; question: string; outcome: TutorOutcome;
  mode: "explain" | "connect" | "challenge" | null; retrieval_mode: "hybrid" | "lexical" | null; subtopic_ids: string[];
  chunks: KbChunk[];
  answer: { segments: TutorSegment[]; follow_up?: string | null; follow_up_question_id?: string | null } | null;
  message: string | null; nearest: KbChunk[]; validation: CitationReport | null; repair_rounds: number; notices: string[]; latency_ms: number;
};

export type StoredTurn = {
  turn_id: string; session_id: string; asked_at: string; question: string; subtopic_ids: string[];
  mode: TutorTurn["mode"]; retrieval_mode: TutorTurn["retrieval_mode"]; retrieved_chunk_ids: string[];
  answer: { segments?: TutorSegment[]; follow_up?: string | null; message?: string; nearest_chunk_ids?: string[] } | null;
  validation_report: CitationReport | null; repair_rounds: number; outcome: TutorOutcome; latency_ms: number | null;
};

export type KbEval = {
  at: string; llm_enabled: boolean; gold_count: number;
  metrics: Record<string, { n: number; of: number; rate: number } | { p50: number | null; p95: number | null } | number | null>;
};
