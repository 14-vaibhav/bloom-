import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  timestamp,
  date,
  integer,
  smallint,
  numeric,
  boolean,
  jsonb,
  bigserial,
  primaryKey,
  uniqueIndex,
  index,
  customType,
} from "drizzle-orm/pg-core";

// pgvector: drizzle-orm has no first-party vector() column in this version, so it's
// defined as a custom type mapping straight onto the `vector(1536)` Postgres type.
const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
});

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// ────────────────────────────────────────────────────────────────
// Domain: Subject → Topic → Subtopic → Concept
// ────────────────────────────────────────────────────────────────

export const subjects = pgTable("subjects", {
  id: text("id").primaryKey(), // 'dsa' | 'cn' | 'rdbms' | 'oop' — readable in logs, not a UUID
  name: text("name").notNull(),
});

export const topics = pgTable("topics", {
  id: text("id").primaryKey(),
  subjectId: text("subject_id").notNull().references(() => subjects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  weight: numeric("weight", { precision: 4, scale: 3 }).notNull(), // siblings within subject sum to 1.0
  baseHours: numeric("base_hours", { precision: 4, scale: 1 }).notNull(),
  difficulty: smallint("difficulty").notNull(),
});

export const subtopics = pgTable("subtopics", {
  id: text("id").primaryKey(),
  topicId: text("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  weight: numeric("weight", { precision: 4, scale: 3 }).notNull(), // siblings within topic sum to 1.0
  baseHours: numeric("base_hours", { precision: 4, scale: 1 }).notNull(),
  difficulty: smallint("difficulty").notNull(),
  description: text("description"),
});

export const topicPrerequisites = pgTable(
  "topic_prerequisites",
  {
    topicId: text("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
    prereqId: text("prereq_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
    strength: numeric("strength", { precision: 3, scale: 2 }).notNull().default("1.0"),
  },
  (t) => [primaryKey({ columns: [t.topicId, t.prereqId] })],
);

export const subtopicPrerequisites = pgTable(
  "subtopic_prerequisites",
  {
    subtopicId: text("subtopic_id").notNull().references(() => subtopics.id, { onDelete: "cascade" }),
    prereqId: text("prereq_id").notNull().references(() => subtopics.id, { onDelete: "cascade" }),
    strength: numeric("strength", { precision: 3, scale: 2 }).notNull().default("1.0"),
  },
  (t) => [primaryKey({ columns: [t.subtopicId, t.prereqId] })],
);

export const concepts = pgTable("concepts", {
  id: text("id").primaryKey(),
  subtopicId: text("subtopic_id").notNull().references(() => subtopics.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
});

// ────────────────────────────────────────────────────────────────
// Student & goal
// ────────────────────────────────────────────────────────────────

export const students = pgTable("students", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  simNow: timestamp("sim_now", { withTimezone: true }).notNull(), // the simulated clock
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const learningGoals = pgTable("learning_goals", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: uuid("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
  subjectId: text("subject_id").notNull().references(() => subjects.id),
  title: text("title").notNull(),
  deadline: date("deadline").notNull(),
  blueprint: jsonb("blueprint").notNull(), // { subtopic_id: weight }, confirmed by the student
  targetMastery: jsonb("target_mastery").notNull(), // { subtopic_id: 0.75 }
  mustHaveSubtopics: text("must_have_subtopics").array().notNull().default(sql`'{}'::text[]`),
  status: text("status", { enum: ["active", "achieved", "abandoned"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("learning_goals_student_status_idx").on(t.studentId, t.status)]);

export const studentConstraints = pgTable("student_constraints", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: uuid("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
  weeklyAvailability: jsonb("weekly_availability").notNull(), // { "1": [{start,end}], ... }
  maxDailyStudyMin: integer("max_daily_study_min").notNull(),
  minSessionMin: integer("min_session_min").notNull(),
  maxSessionMin: integer("max_session_min").notNull(),
  blackoutDates: date("blackout_dates").array().notNull().default(sql`'{}'::date[]`),
  preferredFormats: text("preferred_formats").array().notNull().default(sql`'{}'::text[]`),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(), // never updated in place
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("student_constraints_effective_idx").on(t.studentId, t.effectiveFrom)]);

// ────────────────────────────────────────────────────────────────
// Beliefs (subtopic grain — the mastery model)
// ────────────────────────────────────────────────────────────────

export const subtopicMastery = pgTable(
  "subtopic_mastery",
  {
    studentId: uuid("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
    subtopicId: text("subtopic_id").notNull().references(() => subtopics.id, { onDelete: "cascade" }),
    mu: numeric("mu", { precision: 4, scale: 3 }).notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    learnRate: numeric("learn_rate", { precision: 4, scale: 3 }).notNull().default("0.10"),
    evidenceCount: integer("evidence_count").notNull().default(0),
    retentionEstimate: numeric("retention_estimate", { precision: 4, scale: 3 }),
    strengthDays: numeric("strength_days", { precision: 5, scale: 2 }),
    formatEfficacy: jsonb("format_efficacy").notNull().default(sql`'{"video":0.10,"article":0.10,"practice":0.10}'::jsonb`),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.subtopicId] })],
);

// append-only audit trail; powers the improvement chart. No updates, no deletes.
export const masteryObservations = pgTable(
  "mastery_observations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    studentId: uuid("student_id").notNull(),
    subtopicId: text("subtopic_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source", { enum: ["assessment", "activity", "decay"] }).notNull(),
    // the observation's idempotency key (an assessment_id or activity_id) — see belief.ts's
    // header: the pure dedup check there is backed by this DB-level constraint (bloom-prd-v3
    // §16.2 "phases 1-9 write nothing but events and idempotent beliefs").
    sourceId: text("source_id").notNull(),
    muBefore: numeric("mu_before", { precision: 4, scale: 3 }).notNull(),
    muAfter: numeric("mu_after", { precision: 4, scale: 3 }).notNull(),
    confidenceBefore: numeric("confidence_before", { precision: 4, scale: 3 }).notNull(),
    confidenceAfter: numeric("confidence_after", { precision: 4, scale: 3 }).notNull(),
    evidence: jsonb("evidence"),
  },
  (t) => [
    index("mastery_observations_student_subtopic_idx").on(t.studentId, t.subtopicId, t.observedAt),
    uniqueIndex("mastery_observations_dedup_idx").on(t.studentId, t.subtopicId, t.sourceId),
  ],
);

// ────────────────────────────────────────────────────────────────
// Resources / RAG (with live verification, §14)
// ────────────────────────────────────────────────────────────────

export const resources = pgTable("resources", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  provider: text("provider").notNull(),
  url: text("url").notNull(),
  type: text("type", { enum: ["video", "article", "doc", "course", "practice"] }).notNull(),
  difficulty: smallint("difficulty").notNull(),
  durationMin: integer("duration_min").notNull(),
  quality: numeric("quality", { precision: 3, scale: 2 }).notNull(), // hand-assigned, editorial
  topicIds: text("topic_ids").array().notNull().default(sql`'{}'::text[]`),
  subtopicIds: text("subtopic_ids").array().notNull().default(sql`'{}'::text[]`),
  conceptIds: text("concept_ids").array().notNull().default(sql`'{}'::text[]`),
  description: text("description").notNull(), // this is what gets embedded
  embedding: vector1536("embedding"),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  isLive: boolean("is_live").notNull().default(true),
  verificationFailures: integer("verification_failures").notNull().default(0),
  // set when the resource is a knowledge-base segment (v4 §N6.3)
  sourceId: text("source_id").references(() => sources.id),
  locatorRange: jsonb("locator_range"),
});

export const resourceFeedback = pgTable("resource_feedback", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  studentId: uuid("student_id").notNull(),
  resourceId: text("resource_id").notNull(),
  rating: text("rating", { enum: ["helpful", "unhelpful", "dead_link"] }).notNull(),
  observedMasteryGain: numeric("observed_mastery_gain", { precision: 4, scale: 3 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ────────────────────────────────────────────────────────────────
// Questions & assessment
// ────────────────────────────────────────────────────────────────

export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey(),
    subjectId: text("subject_id").notNull().references(() => subjects.id),
    topicId: text("topic_id").notNull().references(() => topics.id),
    subtopicId: text("subtopic_id").notNull().references(() => subtopics.id),
    conceptId: text("concept_id").references(() => concepts.id),
    difficulty: smallint("difficulty").notNull(),
    stem: text("stem").notNull(),
    options: jsonb("options").notNull(), // string[4]
    correctIndex: smallint("correct_index").notNull(),
    explanation: text("explanation").notNull(),
    reviewed: boolean("reviewed").notNull().default(false),
    origin: text("origin", { enum: ["seeded", "kb_generated"] }).notNull().default("seeded"),
    sourceChunkId: text("source_chunk_id").references(() => sourceChunks.id),
    evidenceQuote: text("evidence_quote"),
  },
  (t) => [index("questions_subtopic_difficulty_idx").on(t.subtopicId, t.difficulty)],
);

// per-attempt log — separate from question_state, which is the rolled-up per-student view
export const questionAttempts = pgTable("question_attempts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  studentId: uuid("student_id").notNull(),
  questionId: text("question_id").notNull(),
  assessmentId: uuid("assessment_id"),
  chosenIndex: smallint("chosen_index").notNull(),
  correct: boolean("correct").notNull(),
  timeSec: integer("time_sec"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// rolled-up exposure state per (student, question) — backs exclude_seen in get_questions
export const questionState = pgTable(
  "question_state",
  {
    studentId: uuid("student_id").notNull(),
    questionId: text("question_id").notNull(),
    timesSeen: integer("times_seen").notNull().default(0),
    timesCorrect: integer("times_correct").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    // set/cleared by qbank.submit_answers (arithmetic, not a belief) — backs get_revision_pool
    inRevisionPool: boolean("in_revision_pool").notNull().default(false),
    weaknessScore: numeric("weakness_score", { precision: 5, scale: 2 }).notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.questionId] })],
);

export const assessments = pgTable("assessments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: uuid("student_id").notNull(),
  activityId: uuid("activity_id"),
  purpose: text("purpose", { enum: ["diagnostic", "checkpoint", "immediate", "active_recall", "retest", "final"] }).notNull(),
  subtopicIds: text("subtopic_ids").array().notNull(),
  questionIds: text("question_ids").array().notNull(),
  composition: jsonb("composition"), // { subtopic_id: count } blueprint used to generate it
  predictedScore: numeric("predicted_score", { precision: 4, scale: 3 }).notNull(), // WRITTEN AT CREATION TIME
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
});

export const assessmentResults = pgTable("assessment_results", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
  score: numeric("score", { precision: 4, scale: 3 }).notNull(),
  perSubtopic: jsonb("per_subtopic").notNull(),
  perConcept: jsonb("per_concept").notNull(),
  predictionError: numeric("prediction_error", { precision: 4, scale: 3 }).notNull(),
  answers: jsonb("answers").notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
});

// ────────────────────────────────────────────────────────────────
// Planning
// ────────────────────────────────────────────────────────────────

export const studyPlans = pgTable("study_plans", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: uuid("student_id").notNull(),
  goalId: uuid("goal_id").notNull().references(() => learningGoals.id, { onDelete: "cascade" }),
  currentVersion: integer("current_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const planVersions = pgTable(
  "plan_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    planId: uuid("plan_id").notNull().references(() => studyPlans.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    parentVersion: integer("parent_version"),
    trigger: text("trigger").notNull(),
    scope: text("scope", { enum: ["PATCH", "FULL", "NEGOTIATE"] }).notNull(),
    reason: text("reason").notNull(),
    diff: jsonb("diff"), // { added:[], removed:[], moved:[], modified:[] }
    gapSnapshot: jsonb("gap_snapshot"),
    projection: jsonb("projection"),
    validationReport: jsonb("validation_report"),
    repairRounds: integer("repair_rounds").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("plan_versions_plan_version_idx").on(t.planId, t.version)],
);

export const learningActivities = pgTable(
  "learning_activities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    planId: uuid("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    studentId: uuid("student_id").notNull(),
    subtopicId: text("subtopic_id").notNull().references(() => subtopics.id),
    resourceId: text("resource_id").references(() => resources.id),
    action: text("action", {
      enum: ["LEARN", "PRACTICE", "IMMEDIATE_TEST", "ACTIVE_RECALL", "REVISION", "FINAL_TEST"],
    }).notNull(),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }).notNull(),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }).notNull(),
    durationMin: integer("duration_min").notNull(),
    priority: numeric("priority", { precision: 5, scale: 2 }),
    predictedScore: numeric("predicted_score", { precision: 4, scale: 3 }),
    expectedMasteryAfter: numeric("expected_mastery_after", { precision: 4, scale: 3 }),
    status: text("status", {
      enum: ["planned", "in_progress", "completed", "missed", "skipped", "cancelled"],
    }).notNull().default("planned"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    missedAt: timestamp("missed_at", { withTimezone: true }),
    actualDurationMin: integer("actual_duration_min"),
    selfRatedDifficulty: smallint("self_rated_difficulty"),
    carriedFromActivityId: uuid("carried_from_activity_id"), // lineage across replans → powers the diff view
    provisional: boolean("provisional").notNull().default(false), // set under degraded-mode planning
    resourceVerified: boolean("resource_verified"),
  },
  (t) => [
    index("learning_activities_student_start_idx").on(t.studentId, t.scheduledStart),
    index("learning_activities_plan_version_idx").on(t.planId, t.planVersion),
    index("learning_activities_planned_idx").on(t.studentId, t.status).where(sql`${t.status} = 'planned'`),
  ],
);

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    studentId: uuid("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    source: text("source", { enum: ["external", "bloom"] }).notNull(),
    busy: boolean("busy").notNull().default(true),
    activityId: uuid("activity_id"),
  },
  (t) => [index("calendar_events_student_start_idx").on(t.studentId, t.startsAt)],
);

// ────────────────────────────────────────────────────────────────
// Agent audit trail + failure recovery
// ────────────────────────────────────────────────────────────────

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    studentId: uuid("student_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // sim_now as read at tick start — distinct from startedAt (real wall-clock, audit-only).
    // The observation collector's delta window is measured against this, never startedAt,
    // so a replay after the demo advances the simulated clock by days (with no real time
    // passing at all) still sees a correct "since last tick" boundary (bloom-phase6-brief §3).
    simAt: timestamp("sim_at", { withTimezone: true }),
    trigger: text("trigger").notNull(),
    scope: text("scope", { enum: ["NONE", "PATCH", "FULL", "NEGOTIATE"] }).notNull(),
    outcome: text("outcome", {
      enum: ["no_action", "patched", "replanned", "infeasible", "error"],
    }),
    status: text("status", { enum: ["running", "completed", "failed", "abandoned"] })
      .notNull()
      .default("running"),
    lastCompletedPhase: smallint("last_completed_phase").notNull().default(0),
    degradedTools: text("degraded_tools").array().notNull().default(sql`'{}'::text[]`),
    errorClass: text("error_class"),
    errorDetail: text("error_detail"),
    recoveredFromRunId: uuid("recovered_from_run_id"),
    newPlanVersion: integer("new_plan_version"),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    llmCallCount: integer("llm_call_count").notNull().default(0),
    totalLatencyMs: integer("total_latency_ms"),
  },
  (t) => [index("agent_runs_running_idx").on(t.status).where(sql`${t.status} = 'running'`)],
);

// append-only. No updates, no deletes — this is the evidence trail.
export const agentEvents = pgTable(
  "agent_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    studentId: uuid("student_id").notNull(),
    seq: integer("seq").notNull(),
    phase: text("phase", {
      enum: [
        "observe", "update_beliefs", "triggers", "analyze", "decide",
        "retrieve", "plan", "validate", "repair", "commit", "act",
      ],
    }).notNull(),
    eventType: text("event_type", {
      enum: ["tool_call", "llm_call", "decision", "state_change", "validation", "notice"],
    }).notNull(),
    toolName: text("tool_name"),
    message: text("message").notNull(), // the human sentence shown in the UI feed
    payload: jsonb("payload"),
    errorClass: text("error_class"),
    retryAttempt: smallint("retry_attempt").notNull().default(0),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_events_student_created_idx").on(t.studentId, t.createdAt),
    index("agent_events_run_seq_idx").on(t.runId, t.seq),
  ],
);

export const toolHealth = pgTable("tool_health", {
  toolName: text("tool_name").primaryKey(), // 'performance' | 'rag' | 'calendar' | 'qbank' | 'state'
  state: text("state", { enum: ["closed", "open", "half_open"] }).notNull().default("closed"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
});

export const dailySummaries = pgTable("daily_summaries", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: uuid("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
  summaryDate: date("summary_date").notNull(),
  message: text("message").notNull(),
  stats: jsonb("stats"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("daily_summaries_student_date_idx").on(t.studentId, t.summaryDate)]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  endpoint: text("endpoint").notNull(),
  response: jsonb("response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Phase 7: deterministic response cache.  The key is a SHA-256 hash of the
// specialist name, prompt version and canonical input; raw prompts are never
// persisted, avoiding accidental storage of provider-specific request blobs.
export const llmCache = pgTable("llm_cache", {
  key: text("key").primaryKey(),
  agent: text("agent").notNull(),
  promptVersion: text("prompt_version").notNull(),
  response: jsonb("response").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  hits: integer("hits").notNull().default(0),
});

// ────────────────────────────────────────────────────────────────
// Evaluation harness (§17 — data seeded in Phase 1, read starting Phase 9)
// ────────────────────────────────────────────────────────────────

export const evalRuns = pgTable("eval_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  config: jsonb("config"),
  seed: integer("seed").notNull(),
  llmEnabled: boolean("llm_enabled").notNull().default(false),
  chaosRate: numeric("chaos_rate", { precision: 4, scale: 3 }).notNull().default("0"),
  metrics: jsonb("metrics"),
});

export const evalStudents = pgTable("eval_students", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  evalRunId: uuid("eval_run_id").notNull().references(() => evalRuns.id, { onDelete: "cascade" }),
  profile: text("profile").notNull(),
  trueMastery: jsonb("true_mastery").notNull(),
  trueLearnRate: numeric("true_learn_rate", { precision: 4, scale: 3 }).notNull(),
  outcome: jsonb("outcome"),
});

// ────────────────────────────────────────────────────────────────
// Knowledge base & tutor (v4 §N2) — offline-ingested course material and cited tutoring
// ────────────────────────────────────────────────────────────────

export const sources = pgTable("sources", {
  id: text("id").primaryKey(), // 'vid_cs50_w5'
  subjectId: text("subject_id").notNull().references(() => subjects.id),
  kind: text("kind", { enum: ["video", "slides", "textbook"] }).notNull(),
  title: text("title").notNull(),
  provider: text("provider"),
  url: text("url"),
  license: text("license"),
  durationSec: integer("duration_sec"), // video only
  unitCount: integer("unit_count"), // pages or slides
  contentHash: text("content_hash"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }),
  ingestReport: jsonb("ingest_report"),
});

export const sourceChunks = pgTable(
  "source_chunks",
  {
    id: text("id").primaryKey(), // '<source_id>:<seq>', deterministic
    sourceId: text("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    modality: text("modality", { enum: ["transcript", "page_text", "slide_vision", "keyframe_vision"] }).notNull(),
    locator: jsonb("locator").notNull(), // {t_start,t_end} | {page,section} | {slide}
    heading: text("heading"),
    text: text("text").notNull(),
    visualDescription: text("visual_description"),
    assetPath: text("asset_path"),
    subtopicIds: text("subtopic_ids").array().notNull().default(sql`'{}'::text[]`),
    conceptIds: text("concept_ids").array().notNull().default(sql`'{}'::text[]`),
    tagSimilarity: numeric("tag_similarity", { precision: 4, scale: 3 }),
    lowInformation: boolean("low_information").notNull().default(false),
    embedding: vector1536("embedding"),
    tsv: tsvector("tsv"), // heading + text + visual_description; populated by the ingest script
  },
  (t) => [
    uniqueIndex("source_chunks_source_seq_idx").on(t.sourceId, t.seq),
    index("source_chunks_subtopic_ids_idx").using("gin", t.subtopicIds),
    index("source_chunks_tsv_idx").using("gin", t.tsv),
  ],
);

export const tutorSessions = pgTable("tutor_sessions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: uuid("student_id").notNull().references(() => students.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tutorTurns = pgTable(
  "tutor_turns",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id").notNull().references(() => tutorSessions.id),
    studentId: uuid("student_id").notNull(),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull(), // sim_now, not wall clock
    question: text("question").notNull(),
    subtopicIds: text("subtopic_ids").array().notNull().default(sql`'{}'::text[]`),
    mode: text("mode", { enum: ["explain", "connect", "challenge"] }),
    retrievalMode: text("retrieval_mode", { enum: ["hybrid", "lexical"] }),
    retrievedChunkIds: text("retrieved_chunk_ids").array().notNull().default(sql`'{}'::text[]`),
    answer: jsonb("answer"), // { segments:[{text, chunk_ids, quote}], follow_up? }
    validationReport: jsonb("validation_report"),
    repairRounds: smallint("repair_rounds").notNull().default(0),
    outcome: text("outcome", {
      enum: ["answered", "extractive_fallback", "declined_no_evidence", "declined_kb_down"],
    }).notNull(),
    contextAssessmentId: uuid("context_assessment_id"),
    contextQuestionId: text("context_question_id"),
    trace: jsonb("trace"),
    latencyMs: integer("latency_ms"),
  },
  (t) => [index("tutor_turns_student_asked_idx").on(t.studentId, t.askedAt.desc())],
);
