/**
 * Degraded-mode fallback registry (bloom-phase2-brief.md §8). A breaker that
 * just returns an error is engineering; a fallback that changes what the
 * caller does next is agentic. Each bucket's fallback is defined for the one
 * operation the brief's table actually specifies — search_learning_resources
 * for RAG, get_available_slots for Calendar, compose_assessment for Question
 * Bank, get_subtopic_performance for Performance. Any other operation on a
 * broken tool has no bespoke fallback and just fails unavailable; the
 * planner/orchestrator consuming these signals is Phase 4/6, not Phase 2.
 */

import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { resourceFeedback, resources, subtopicMastery } from "../db/schema.js";
import { StateStoreUnavailableError } from "./errors.js";
import { resolveEffectiveConstraints } from "./shared.js";
import { eachUtcDayInRange, utcDayOfWeek, wallClockToUtc, minutesBetween } from "../lib/time.js";
import type { ToolBucket } from "./errors.js";
import type { ToolInput, ToolOutput } from "./schemas.js";

export type DegradedSignal =
  | "SUBSTITUTE_ACTIVITY_TYPE"
  | "PROVISIONAL_PLAN"
  | "DEFER_ASSESSMENTS"
  | "REDUCED_CONFIDENCE";

export type DegradedResult = { data: unknown; signal?: DegradedSignal; message: string };

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

async function ragSearchFallback(
  input: ToolInput<"rag.search_learning_resources">,
): Promise<DegradedResult> {
  const [lastGood] = await db
    .select({ resource: resources, feedback: resourceFeedback })
    .from(resourceFeedback)
    .innerJoin(resources, eq(resources.id, resourceFeedback.resourceId))
    .where(sql`${resourceFeedback.rating} = 'helpful' and ${resources.subtopicIds} @> ARRAY[${input.subtopic_id}]::text[]`)
    .orderBy(desc(resourceFeedback.createdAt))
    .limit(1);

  if (lastGood) {
    const r = lastGood.resource;
    const hit: ToolOutput<"rag.search_learning_resources">[number] = {
      id: r.id,
      title: r.title,
      provider: r.provider,
      url: r.url,
      type: r.type,
      difficulty: r.difficulty,
      duration_min: r.durationMin,
      quality: num(r.quality),
      similarity: null,
      ranked_by: "fallback_quality",
      verified: false,
      is_live: r.isLive,
      subtopic_ids: r.subtopicIds,
      concept_ids: r.conceptIds,
    };
    return {
      data: [hit],
      message: `RAG unavailable — reusing ${r.id} for ${input.subtopic_id}, flagged for review.`,
    };
  }

  return {
    data: [],
    signal: "SUBSTITUTE_ACTIVITY_TYPE",
    message: `RAG unavailable — no known-good resource for ${input.subtopic_id}; substitute PRACTICE from the question bank instead of LEARN.`,
  };
}

async function calendarSlotsFallback(
  input: ToolInput<"calendar.get_available_slots">,
): Promise<DegradedResult> {
  const from = new Date(input.from);
  const to = new Date(input.to);
  const constraints = await resolveEffectiveConstraints(input.student_id, from);
  if (!constraints) {
    return { data: [], signal: "PROVISIONAL_PLAN", message: "Calendar unavailable and no availability template on file." };
  }

  const weekly = constraints.weeklyAvailability as Record<string, Array<{ start: string; end: string }>>;
  const blackout = new Set(constraints.blackoutDates);
  const slots: ToolOutput<"calendar.get_available_slots"> = [];

  for (const day of eachUtcDayInRange(from, to)) {
    const dateKey = day.toISOString().slice(0, 10);
    if (blackout.has(dateKey)) continue;
    for (const w of weekly[utcDayOfWeek(day)] ?? []) {
      const start = wallClockToUtc(day, w.start);
      const end = wallClockToUtc(day, w.end);
      if (end <= start) continue;
      const duration = minutesBetween(start, end);
      if (duration < input.min_slot_min) continue;
      slots.push({ start: start.toISOString(), end: end.toISOString(), duration_min: duration, energy_weight: 1.0 });
    }
  }

  return {
    data: slots,
    signal: "PROVISIONAL_PLAN",
    message: "Calendar unavailable — planned against availability template; plan marked provisional.",
  };
}

async function qbankComposeFallback(
  input: ToolInput<"qbank.compose_assessment">,
): Promise<DegradedResult> {
  return {
    data: null,
    signal: "DEFER_ASSESSMENTS",
    message: `Question bank unavailable — assessment for ${input.subtopic_id} deferred by one day.`,
  };
}

async function performanceSubtopicFallback(
  input: ToolInput<"performance.get_subtopic_performance">,
): Promise<DegradedResult> {
  const ids = input.subtopic_ids ?? [];
  const rows = ids.length
    ? await db.query.subtopicMastery.findMany({
        where: (m, { and, eq, inArray }) => and(eq(m.studentId, input.student_id), inArray(m.subtopicId, ids)),
      })
    : await db.query.subtopicMastery.findMany({ where: (m, { eq }) => eq(m.studentId, input.student_id) });

  const data: ToolOutput<"performance.get_subtopic_performance"> = rows.map((m) => ({
    subtopic_id: m.subtopicId,
    mu: num(m.mu),
    confidence: num(m.confidence) * 0.9,
    learn_rate: num(m.learnRate),
    evidence_count: m.evidenceCount,
    retention_estimate: m.retentionEstimate !== null ? num(m.retentionEstimate) : null,
    strength_days: m.strengthDays !== null ? num(m.strengthDays) : null,
    days_stale: m.lastObservedAt ? (Date.now() - m.lastObservedAt.getTime()) / 86400000 : null,
    recent_scores: [],
    trend: null,
    minutes_invested: 0,
    format_efficacy: (m.formatEfficacy as Record<string, number>) ?? { video: 0.1, article: 0.1, practice: 0.1 },
  }));

  return {
    data,
    signal: "REDUCED_CONFIDENCE",
    message: "Performance tool unavailable — using cached beliefs at reduced confidence.",
  };
}

export async function getDegradedFallback(
  bucket: ToolBucket,
  operation: string,
  input: unknown,
): Promise<DegradedResult | null> {
  if (bucket === "state") {
    throw new StateStoreUnavailableError("State store unavailable — run aborted, no changes committed.");
  }
  if (bucket === "rag" && operation === "search_learning_resources") {
    return ragSearchFallback(input as ToolInput<"rag.search_learning_resources">);
  }
  if (bucket === "calendar" && operation === "get_available_slots") {
    return calendarSlotsFallback(input as ToolInput<"calendar.get_available_slots">);
  }
  if (bucket === "qbank" && operation === "compose_assessment") {
    return qbankComposeFallback(input as ToolInput<"qbank.compose_assessment">);
  }
  if (bucket === "performance" && operation === "get_subtopic_performance") {
    return performanceSubtopicFallback(input as ToolInput<"performance.get_subtopic_performance">);
  }
  return null;
}
