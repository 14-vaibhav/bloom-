/**
 * One Zod schema per operation input and output, keyed "tool.operation". This
 * file is the single source of truth for three consumers: runtime validation
 * in the dispatcher, the LLM tool definitions (Phase 7), and the frontend
 * types (Phase 8). Derive everything from these — never hand-write a mirror
 * TypeScript interface.
 *
 * A few operations described in bloom-phase2-brief.md §4 reference concepts
 * the Phase 1 schema doesn't carry yet (a revision pool flag, a generic
 * observation log). Where that happens the shape is still defined in full
 * here — only the backing implementation is a documented placeholder. See
 * qbank.ts / state.ts for exactly which ops that applies to.
 */

import { z } from "zod";

export const ToolBucketSchema = z.enum(["performance", "rag", "calendar", "qbank", "state", "kb"]);

// ── shared fragments ──────────────────────────────────────────────

const uuidField = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const wallClock = z.string().regex(/^\d{2}:\d{2}$/);

const ResourceHit = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  url: z.string(),
  type: z.enum(["video", "article", "doc", "course", "practice"]),
  difficulty: z.number().int().min(1).max(5),
  duration_min: z.number().int().positive(),
  quality: z.number().min(0).max(1),
  similarity: z.number().min(0).max(1).nullable(),
  ranked_by: z.enum(["embedding", "fallback_quality"]),
  verified: z.boolean(),
  is_live: z.boolean(),
  subtopic_ids: z.array(z.string()),
  concept_ids: z.array(z.string()),
});

const KbChunk = z.object({
  chunk_id: z.string(), source_id: z.string(), source_title: z.string(), kind: z.enum(["video", "slides", "textbook"]),
  modality: z.string(), locator: z.record(z.string(), z.unknown()), label: z.string(), deep_link: z.string(),
  asset_url: z.string().nullable(), text: z.string(), visual_description: z.string().nullable(),
  subtopic_ids: z.array(z.string()), score: z.number(),
});

const ReviewSource = z.object({
  chunk_id: z.string(), source_id: z.string(), kind: z.enum(["video", "slides", "textbook"]),
  label: z.string(), deep_link: z.string(), own: z.boolean(),
});

const SubtopicPerf = z.object({
  subtopic_id: z.string(),
  mu: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  learn_rate: z.number().min(0).max(1),
  evidence_count: z.number().int().min(0),
  retention_estimate: z.number().min(0).max(1).nullable(),
  strength_days: z.number().nullable(),
  days_stale: z.number().nullable(),
  recent_scores: z.array(z.number()),
  trend: z.number().nullable(),
  minutes_invested: z.number().min(0),
  format_efficacy: z.record(z.string(), z.number()),
});

const CalendarEvent = z.object({
  event_id: uuidField,
  title: z.string(),
  starts_at: isoDateTime,
  ends_at: isoDateTime,
  source: z.enum(["external", "bloom"]),
  busy: z.boolean(),
  activity_id: uuidField.nullable(),
});

const AvailableSlot = z.object({
  start: isoDateTime,
  end: isoDateTime,
  duration_min: z.number().int().positive(),
  energy_weight: z.number().positive(),
});

const QuestionPublic = z.object({
  question_id: z.string(),
  subtopic_id: z.string(),
  concept_id: z.string().nullable(),
  difficulty: z.number().int().min(1).max(5),
  stem: z.string(),
  options: z.array(z.string()),
});

const ActivityRecord = z.object({
  activity_id: uuidField,
  subtopic_id: z.string(),
  resource_id: z.string().nullable(),
  action: z.enum(["LEARN", "PRACTICE", "IMMEDIATE_TEST", "ACTIVE_RECALL", "REVISION", "FINAL_TEST"]),
  scheduled_start: isoDateTime,
  scheduled_end: isoDateTime,
  duration_min: z.number().int().positive(),
  priority: z.number().nullable(),
  predicted_score: z.number().min(0).max(1).nullable(),
  expected_mastery_after: z.number().min(0).max(1).nullable(),
  status: z.enum(["planned", "in_progress", "completed", "missed", "skipped", "cancelled"]),
  provisional: z.boolean(),
});

// ── tool schemas ──────────────────────────────────────────────────

export const toolSchemas = {
  // ---- performance (4) ----
  "performance.get_student_performance": {
    bucket: "performance",
    input: z.object({ student_id: uuidField }),
    output: z.object({
      overall_mastery: z.number().min(0).max(1),
      trend_7d: z.number().nullable(),
      completion_ratio_14d: z.number().min(0).max(1).nullable(),
      total_study_minutes: z.number().min(0),
      assessments_taken: z.number().int().min(0),
      last_activity_at: isoDateTime.nullable(),
    }),
  },

  "performance.get_subtopic_performance": {
    bucket: "performance",
    input: z.object({ student_id: uuidField, subtopic_ids: z.array(z.string()).optional() }),
    output: z.array(SubtopicPerf),
  },

  "performance.get_assessment_history": {
    bucket: "performance",
    input: z.object({ student_id: uuidField, limit: z.number().int().min(1).max(200).default(20) }),
    output: z.array(
      z.object({
        assessment_id: uuidField,
        purpose: z.enum(["diagnostic", "checkpoint", "immediate", "active_recall", "retest", "final"]),
        subtopic_ids: z.array(z.string()),
        score: z.number().min(0).max(1).nullable(),
        predicted_score: z.number().min(0).max(1),
        prediction_error: z.number().nullable(),
        submitted_at: isoDateTime.nullable(),
        questions: z.array(
          z.object({
            question_id: z.string(),
            subtopic_id: z.string(),
            concept_id: z.string().nullable(),
            chosen_index: z.number().int().nullable(),
            correct_index: z.number().int(),
            correct: z.boolean().nullable(),
          }),
        ),
      }),
    ),
  },

  "performance.get_completion_history": {
    bucket: "performance",
    input: z.object({ student_id: uuidField, since: isoDateTime }),
    output: z.array(
      z.object({
        activity_id: uuidField,
        subtopic_id: z.string(),
        action: z.string(),
        status: z.string(),
        scheduled_start: isoDateTime,
        scheduled_end: isoDateTime,
        scheduled_duration_min: z.number().int(),
        actual_duration_min: z.number().int().nullable(),
        self_rated_difficulty: z.number().int().nullable(),
        completed_at: isoDateTime.nullable(),
      }),
    ),
  },

  // ---- rag (2) ----
  "rag.search_learning_resources": {
    bucket: "rag",
    input: z.object({
      subtopic_id: z.string(),
      target_difficulty: z.number().int().min(1).max(5),
      max_duration_min: z.number().int().positive(),
      types: z.array(z.enum(["video", "article", "doc", "course", "practice"])).optional(),
      focus_concept: z.string().optional(),
      exclude_ids: z.array(z.string()).default([]),
      k: z.number().int().min(1).max(20).default(8),
    }),
    output: z.array(ResourceHit),
  },

  "rag.get_resource_details": {
    bucket: "rag",
    input: z.object({ resource_id: z.string() }),
    output: z.object({
      id: z.string(),
      title: z.string(),
      provider: z.string(),
      url: z.string(),
      type: z.enum(["video", "article", "doc", "course", "practice"]),
      difficulty: z.number().int(),
      duration_min: z.number().int(),
      quality: z.number(),
      topic_ids: z.array(z.string()),
      subtopic_ids: z.array(z.string()),
      concept_ids: z.array(z.string()),
      description: z.string(),
      is_live: z.boolean(),
      last_verified_at: isoDateTime.nullable(),
      verification_failures: z.number().int(),
    }),
  },

  // ---- calendar (5) ----
  "calendar.get_existing_events": {
    bucket: "calendar",
    input: z.object({ student_id: uuidField, from: isoDateTime, to: isoDateTime }),
    output: z.array(CalendarEvent),
  },

  "calendar.get_available_slots": {
    bucket: "calendar",
    input: z.object({
      student_id: uuidField,
      from: isoDateTime,
      to: isoDateTime,
      min_slot_min: z.number().int().positive(),
    }),
    output: z.array(AvailableSlot),
  },

  "calendar.create_learning_session": {
    bucket: "calendar",
    input: z.object({
      activity_id: uuidField,
      start: isoDateTime,
      end: isoDateTime,
      title: z.string(),
    }),
    output: CalendarEvent,
  },

  "calendar.modify_learning_session": {
    bucket: "calendar",
    input: z.object({ event_id: uuidField, start: isoDateTime, end: isoDateTime }),
    output: CalendarEvent,
  },

  "calendar.delete_learning_session": {
    bucket: "calendar",
    input: z.object({ event_id: uuidField }),
    output: z.object({ event_id: uuidField, deleted: z.boolean() }),
  },

  // ---- question bank (4) ----
  "qbank.get_questions": {
    bucket: "qbank",
    input: z.object({
      subtopic_ids: z.array(z.string()).min(1),
      difficulty: z.number().int().min(1).max(5).optional(),
      count: z.number().int().min(1).max(100),
      exclude_seen: z.boolean().default(true),
      student_id: uuidField.optional(),
      reviewed_only: z.boolean().default(true), // v4 §N6.2: only human-reviewed answer keys reach a student
    }),
    output: z.array(QuestionPublic),
  },

  "qbank.compose_assessment": {
    bucket: "qbank",
    input: z.object({
      student_id: uuidField,
      subtopic_id: z.string(),
      purpose: z.enum(["diagnostic", "checkpoint", "immediate", "active_recall", "retest", "final"]),
      count: z.number().int().min(1).max(50),
      idempotency_key: z.string().optional(),
    }),
    output: z.object({
      assessment_id: uuidField,
      subtopic_ids: z.array(z.string()),
      purpose: z.enum(["diagnostic", "checkpoint", "immediate", "active_recall", "retest", "final"]),
      question_ids: z.array(z.string()),
      composition: z.object({ new: z.number().int(), revision: z.number().int(), targeted: z.number().int(), correct: z.number().int() }),
      predicted_score: z.number().min(0).max(1),
      created_at: isoDateTime,
    }),
  },

  "qbank.submit_answers": {
    bucket: "qbank",
    input: z.object({
      assessment_id: uuidField,
      answers: z.array(
        z.object({
          question_id: z.string(),
          chosen_index: z.number().int().min(0),
          time_sec: z.number().int().positive().optional(),
        }),
      ),
      idempotency_key: z.string().optional(),
    }),
    output: z.object({
      assessment_id: uuidField,
      score: z.number().min(0).max(1),
      per_subtopic: z.record(z.string(), z.number()),
      per_concept: z.record(z.string(), z.object({ correct: z.number().int(), total: z.number().int(), accuracy: z.number() })),
      prediction_error: z.number(),
      significant: z.boolean(),
      submitted_at: isoDateTime,
      revision_pool_additions: z.array(z.string()),
      cleared_questions: z.array(z.string()),
      // v4 §N6.3: where to re-read each wrongly answered question, keyed by question_id
      review_sources: z.record(z.string(), z.array(ReviewSource)).default({}),
      review_sources_note: z.string().nullable().default(null),
    }),
  },

  "qbank.get_revision_pool": {
    bucket: "qbank",
    input: z.object({ student_id: uuidField, subtopic_id: z.string().optional() }),
    output: z.array(
      z.object({
        question_id: z.string(),
        subtopic_id: z.string(),
        weakness_score: z.number(),
        stem: z.string(),
        options: z.array(z.string()),
      }),
    ),
  },

  // ---- student state (6) ----
  "state.get_student_state": {
    bucket: "state",
    input: z.object({ student_id: uuidField }),
    output: z.object({
      student: z.object({ id: uuidField, name: z.string(), email: z.string(), sim_now: isoDateTime }),
      goal: z
        .object({
          goal_id: uuidField,
          subject_id: z.string(),
          title: z.string(),
          deadline: z.string(),
          blueprint: z.record(z.string(), z.number()),
          target_mastery: z.record(z.string(), z.number()),
          must_have_subtopics: z.array(z.string()),
          status: z.enum(["active", "achieved", "abandoned"]),
        })
        .nullable(),
      constraints: z
        .object({
          weekly_availability: z.record(z.string(), z.array(z.object({ start: wallClock, end: wallClock }))),
          max_daily_study_min: z.number().int(),
          min_session_min: z.number().int(),
          max_session_min: z.number().int(),
          blackout_dates: z.array(z.string()),
          preferred_formats: z.array(z.string()),
          effective_from: isoDateTime,
        })
        .nullable(),
      plan: z
        .object({
          plan_id: uuidField,
          current_version: z.number().int(),
          upcoming_activities: z.array(ActivityRecord),
        })
        .nullable(),
      recent_mastery: z.array(SubtopicPerf),
      projection: z.null(), // computed by the orchestrator from Phase 6 onward
    }),
  },

  "state.patch_student_state": {
    bucket: "state",
    input: z.object({ student_id: uuidField, patch: z.object({ sim_now: isoDateTime.optional() }) }),
    output: z.object({ id: uuidField, name: z.string(), email: z.string(), sim_now: isoDateTime }),
  },

  "state.append_observation": {
    bucket: "state",
    input: z.object({
      student_id: uuidField,
      run_id: uuidField, // the run this observation belongs to — its evidence trail lives in agent_events
      type: z.string(), // e.g. "RESOURCE_FAILURE", "TOOL_RECOVERED" — trigger evaluator (Phase 6) scans these
      payload: z.record(z.string(), z.unknown()).default({}),
      phase: z
        .enum([
          "observe", "update_beliefs", "triggers", "analyze", "decide",
          "retrieve", "plan", "validate", "repair", "commit", "act",
        ])
        .default("act"),
    }),
    output: z.object({ event_id: z.number().int(), message: z.string() }),
  },

  "state.get_plan": {
    bucket: "state",
    input: z.object({ student_id: uuidField, version: z.number().int().optional() }),
    output: z
      .object({
        plan_id: uuidField,
        version: z.number().int(),
        parent_version: z.number().int().nullable(),
        trigger: z.string(),
        scope: z.enum(["PATCH", "FULL", "NEGOTIATE"]),
        reason: z.string(),
        diff: z.unknown().nullable(),
        validation_report: z.unknown().nullable(),
        repair_rounds: z.number().int(),
        created_at: isoDateTime,
        activities: z.array(ActivityRecord),
      })
      .nullable(),
  },

  "state.save_plan_version": {
    bucket: "state",
    input: z.object({
      student_id: uuidField,
      goal_id: uuidField,
      plan_id: uuidField.optional(), // omit to create a new plan (first FULL)
      version: z.number().int().min(1),
      parent_version: z.number().int().nullable().optional(),
      trigger: z.string(),
      scope: z.enum(["PATCH", "FULL", "NEGOTIATE"]),
      reason: z.string(),
      diff: z.unknown().optional(),
      gap_snapshot: z.unknown().optional(),
      projection: z.unknown().optional(),
      validation_report: z.unknown().optional(),
      repair_rounds: z.number().int().min(0).default(0),
      run_id: uuidField.optional(), // if set, agent_runs.status/newPlanVersion updated in the same transaction
      // Bloom-source calendar events tied to these (previous-version) activity ids are
      // deleted in the SAME transaction as the new version's insert (bloom-prd-v3 §16.4) —
      // otherwise a superseded still-"planned" session's busy block lingers forever and
      // silently eats availability for every future get_available_slots call.
      supersedes_activity_ids: z.array(uuidField).default([]),
      activities: z.array(
        z.object({
          subtopic_id: z.string(),
          resource_id: z.string().nullable().optional(),
          action: z.enum(["LEARN", "PRACTICE", "IMMEDIATE_TEST", "ACTIVE_RECALL", "REVISION", "FINAL_TEST"]),
          scheduled_start: isoDateTime,
          scheduled_end: isoDateTime,
          duration_min: z.number().int().positive(),
          priority: z.number().optional(),
          predicted_score: z.number().min(0).max(1).optional(),
          expected_mastery_after: z.number().min(0).max(1).optional(),
          carried_from_activity_id: uuidField.optional(),
          provisional: z.boolean().default(false),
          create_calendar_session: z.boolean().default(true),
        }),
      ),
      idempotency_key: z.string().optional(),
    }),
    output: z.object({
      plan_id: uuidField,
      plan_version_id: uuidField,
      version: z.number().int(),
      activity_ids: z.array(uuidField),
      calendar_event_ids: z.array(uuidField),
    }),
  },

  "state.get_constraints": {
    bucket: "state",
    input: z.object({ student_id: uuidField, effective_at: isoDateTime }),
    output: z
      .object({
        weekly_availability: z.record(z.string(), z.array(z.object({ start: wallClock, end: wallClock }))),
        max_daily_study_min: z.number().int(),
        min_session_min: z.number().int(),
        max_session_min: z.number().int(),
        blackout_dates: z.array(z.string()),
        preferred_formats: z.array(z.string()),
        effective_from: isoDateTime,
      })
      .nullable(),
  },
  // ── Tool 6: Knowledge Base (v4 §N3) ─────────────────────────────
  "kb.search_course_content": {
    bucket: "kb",
    input: z.object({
      query: z.string().min(2).max(500),
      subtopic_ids: z.array(z.string()).optional(), // soft boost, not a filter
      kinds: z.array(z.enum(["video", "slides", "textbook"])).optional(),
      k: z.number().int().min(1).max(20).default(8),
    }),
    output: z.object({
      retrieval_mode: z.enum(["hybrid", "lexical"]),
      chunks: z.array(KbChunk),
      nearest: z.array(KbChunk),
      top_similarity: z.number().nullable(),
    }),
  },

  "kb.get_chunk": {
    bucket: "kb",
    input: z.object({ chunk_id: z.string() }),
    output: KbChunk.extend({ neighbours: z.object({ prev_id: z.string().nullable(), next_id: z.string().nullable() }) }),
  },

  "kb.get_source_outline": {
    bucket: "kb",
    input: z.object({ source_id: z.string() }),
    output: z.object({
      source: z.object({
        id: z.string(), kind: z.enum(["video", "slides", "textbook"]), title: z.string(), provider: z.string().nullable(),
        url: z.string().nullable(), license: z.string().nullable(), duration_sec: z.number().nullable(),
        unit_count: z.number().nullable(), chunk_count: z.number().int(),
      }),
      units: z.array(z.object({
        locator: z.record(z.string(), z.unknown()), heading: z.string().nullable(),
        chunk_ids: z.array(z.string()), subtopic_ids: z.array(z.string()),
      })),
    }),
  },
} as const;

export type ToolName = keyof typeof toolSchemas;

export type ToolInput<T extends ToolName> = z.input<(typeof toolSchemas)[T]["input"]>;
export type ToolOutput<T extends ToolName> = z.infer<(typeof toolSchemas)[T]["output"]>;

export function bucketFor(name: ToolName): "performance" | "rag" | "calendar" | "qbank" | "state" | "kb" {
  return toolSchemas[name].bucket;
}

export const ALL_TOOL_NAMES = Object.keys(toolSchemas) as ToolName[];
