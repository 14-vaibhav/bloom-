/**
 * UPDATE BELIEFS (phase 2 of the orchestrator loop) — the one domain write
 * that happens outside the phase-10 commit transaction (bloom-phase6-brief
 * §2). A student answering a question is a fact about the world, independent
 * of whether the tick's eventual replan succeeds, so it's written immediately.
 * Safety comes from idempotency, not from waiting for the commit: the unique
 * index on mastery_observations(student_id, subtopic_id, source_id) makes a
 * duplicate observation ID a no-op (`onConflictDoNothing`), exactly as
 * belief.ts's own header promises.
 *
 * This module is the DB boundary around the pure core/belief.ts and
 * core/decay.ts — no model math lives here.
 */

import { applyObservation } from "../core/belief.js";
import { applyDecay } from "../core/decay.js";
import type { FormatEfficacy, Observation, SubtopicBelief } from "../core/types.js";
import { db } from "../db/client.js";
import { masteryObservations, subtopicMastery } from "../db/schema.js";

const DEFAULT_FORMAT_EFFICACY: FormatEfficacy = { video: 0.10, article: 0.10, practice: 0.10, doc: 0.10, course: 0.10 };

type MasteryRow = typeof subtopicMastery.$inferSelect;

function num(v: string | number | null): number {
  if (v === null) return 0;
  return typeof v === "number" ? v : Number(v);
}

function rowToBelief(row: MasteryRow | undefined, subtopicId: string): SubtopicBelief {
  if (!row) {
    return {
      subtopic_id: subtopicId,
      mu: 0,
      confidence: 0,
      learn_rate: 0.10,
      evidence_count: 0,
      assessment_count: 0,
      last_observed_at: null,
      mu_at_last_observation: 0,
      hours_since_last_observation: 0,
      prediction_error_ema: 0,
      format_efficacy: DEFAULT_FORMAT_EFFICACY,
      retention_estimate: 0,
      strength_days: 3,
    };
  }
  return {
    subtopic_id: subtopicId,
    mu: num(row.mu),
    confidence: num(row.confidence),
    learn_rate: num(row.learnRate),
    evidence_count: row.evidenceCount,
    assessment_count: 0, // not persisted — see bloom-phase6-brief notes; only used within a single applyObservation call
    last_observed_at: row.lastObservedAt,
    mu_at_last_observation: num(row.mu), // always in sync with mu — see belief.ts: both are set together on every observation
    hours_since_last_observation: 0,
    prediction_error_ema: 0,
    // merge over the full default so a row seeded before doc/course existed (or written by
    // an older version of this default) never leaves applyObservation indexing an undefined key
    format_efficacy: { ...DEFAULT_FORMAT_EFFICACY, ...(row.formatEfficacy as Partial<FormatEfficacy> | null) },
    retention_estimate: row.retentionEstimate !== null ? num(row.retentionEstimate) : 0,
    strength_days: row.strengthDays !== null ? num(row.strengthDays) : 3,
  };
}

async function loadBelief(studentId: string, subtopicId: string): Promise<SubtopicBelief> {
  const [exact] = await db.query.subtopicMastery.findMany({
    where: (m, { and, eq }) => and(eq(m.studentId, studentId), eq(m.subtopicId, subtopicId)),
  });
  return rowToBelief(exact, subtopicId);
}

async function persistBelief(studentId: string, belief: SubtopicBelief): Promise<void> {
  await db
    .insert(subtopicMastery)
    .values({
      studentId,
      subtopicId: belief.subtopic_id,
      mu: String(belief.mu),
      confidence: String(belief.confidence),
      learnRate: String(belief.learn_rate),
      evidenceCount: belief.evidence_count,
      retentionEstimate: String(belief.retention_estimate),
      strengthDays: String(belief.strength_days),
      formatEfficacy: belief.format_efficacy,
      lastObservedAt: belief.last_observed_at,
    })
    .onConflictDoUpdate({
      target: [subtopicMastery.studentId, subtopicMastery.subtopicId],
      set: {
        mu: String(belief.mu),
        confidence: String(belief.confidence),
        learnRate: String(belief.learn_rate),
        evidenceCount: belief.evidence_count,
        retentionEstimate: String(belief.retention_estimate),
        strengthDays: String(belief.strength_days),
        formatEfficacy: belief.format_efficacy,
        lastObservedAt: belief.last_observed_at,
      },
    });
}

export type ObservationInput = Observation & { subtopic_id: string; source: "assessment" | "activity" };

export type BeliefUpdateOutcome = {
  subtopic_id: string;
  applied: boolean; // false when this source_id was already recorded (idempotent no-op)
  mu_before: number;
  mu_after: number;
  confidence_before: number;
  confidence_after: number;
  learn_rate_before: number;
  learn_rate_after: number;
  significant: boolean;
  belief: SubtopicBelief;
};

/**
 * Applies one observation to one subtopic's belief, decaying first (elapsed
 * time since the belief was last touched still counts), then updating,
 * idempotent on (student_id, subtopic_id, source_id). Safe to call multiple
 * times with the same source_id — the DB constraint makes the repeat a
 * no-op and the caller gets `applied: false` back.
 */
export async function updateBelief(studentId: string, obs: ObservationInput, now: Date): Promise<BeliefUpdateOutcome> {
  const current = await loadBelief(studentId, obs.subtopic_id);
  const decayed = applyDecay(current, now);
  const { belief: updated, delta } = applyObservation(decayed, obs, now);

  if (!delta) {
    return {
      subtopic_id: obs.subtopic_id,
      applied: false,
      mu_before: decayed.mu,
      mu_after: decayed.mu,
      confidence_before: decayed.confidence,
      confidence_after: decayed.confidence,
      learn_rate_before: decayed.learn_rate,
      learn_rate_after: decayed.learn_rate,
      significant: false,
      belief: decayed,
    };
  }

  // Idempotency is enforced here, at the DB boundary, not by the pure function above (which
  // only ever sees the caller's own in-memory appliedSourceIds set). A concurrent duplicate
  // insert loses the race harmlessly; onConflictDoNothing skips the row and returns nothing.
  const inserted = await db
    .insert(masteryObservations)
    .values({
      studentId,
      subtopicId: obs.subtopic_id,
      observedAt: now,
      source: obs.source,
      sourceId: obs.source_id,
      muBefore: String(delta.mu_before),
      muAfter: String(delta.mu_after),
      confidenceBefore: String(delta.confidence_before),
      confidenceAfter: String(delta.confidence_after),
      evidence: { n: obs.n, difficulty: obs.difficulty, score: obs.score, predicted_score: obs.predicted_score ?? null },
    })
    .onConflictDoNothing({ target: [masteryObservations.studentId, masteryObservations.subtopicId, masteryObservations.sourceId] })
    .returning({ id: masteryObservations.id });

  if (inserted.length === 0) {
    // Someone else (or an earlier attempt this same tick) already recorded this source_id.
    return {
      subtopic_id: obs.subtopic_id,
      applied: false,
      mu_before: decayed.mu,
      mu_after: decayed.mu,
      confidence_before: decayed.confidence,
      confidence_after: decayed.confidence,
      learn_rate_before: decayed.learn_rate,
      learn_rate_after: decayed.learn_rate,
      significant: false,
      belief: decayed,
    };
  }

  await persistBelief(studentId, updated);

  return {
    subtopic_id: obs.subtopic_id,
    applied: true,
    mu_before: delta.mu_before,
    mu_after: delta.mu_after,
    confidence_before: delta.confidence_before,
    confidence_after: delta.confidence_after,
    learn_rate_before: delta.learn_rate_before,
    learn_rate_after: delta.learn_rate_after,
    significant: delta.significant,
    belief: updated,
  };
}

/** Refreshes the decay-only cache (confidence/retention/strength) for a subtopic with no
 * new evidence this tick — §5 of decay.ts: "a cache Phase 6 refreshes," never the source. */
export async function refreshDecay(studentId: string, subtopicId: string, now: Date): Promise<SubtopicBelief> {
  const current = await loadBelief(studentId, subtopicId);
  const decayed = applyDecay(current, now);
  if (decayed === current) return current; // no time elapsed since last_observed_at — nothing to persist
  await persistBelief(studentId, decayed);
  return decayed;
}

export async function getBelief(studentId: string, subtopicId: string): Promise<SubtopicBelief> {
  return loadBelief(studentId, subtopicId);
}

export async function getAllBeliefs(studentId: string, subtopicIds: string[]): Promise<Map<string, SubtopicBelief>> {
  const rows = await db.query.subtopicMastery.findMany({
    where: (m, { and, eq, inArray }) => and(eq(m.studentId, studentId), inArray(m.subtopicId, subtopicIds)),
  });
  const byId = new Map(rows.map((r) => [r.subtopicId, r]));
  const out = new Map<string, SubtopicBelief>();
  for (const id of subtopicIds) out.set(id, rowToBelief(byId.get(id), id));
  return out;
}
