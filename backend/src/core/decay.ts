/**
 * Confidence decay and retention are separate concepts (bloom-phase3-brief
 * §5): confidence decay says how much we still trust mu; retention is a
 * forgetting-curve estimate of what the student probably still knows. Both
 * are pure functions of elapsed time, computed on demand — never stored as
 * truth. subtopic_mastery's retention_estimate/strength_days columns are a
 * cache Phase 6 refreshes by calling applyDecay(), not the source.
 */

import { BELIEF, RECALL } from "./constants.js";
import type { SubtopicBelief } from "./types.js";
import { clamp, daysBetween } from "./util.js";

export function decayConfidence(confidence: number, daysSince: number): number {
  return clamp(confidence * Math.pow(BELIEF.confidence_decay_daily, Math.max(0, daysSince)), 0, 1);
}

export function computeStrengthDays(mu: number, confidence: number): number {
  return RECALL.strength_base + RECALL.strength_scale * mu * confidence;
}

export function estimateRetention(mu: number, confidence: number, daysSince: number): number {
  if (daysSince <= 0) return clamp(mu, 0, 1);
  const strength = computeStrengthDays(mu, confidence);
  return clamp(mu * Math.exp(-daysSince / strength), 0, 1);
}

/**
 * Strength and retention (§5's worked example) are computed from the
 * confidence as it stood at last_observed_at — how sure we were when the
 * belief was last confirmed — not from the confidence this same call is
 * about to decay. Only the returned `confidence` field is the decayed
 * value. Callers must thread the belief returned by applyObservation (or an
 * unmodified previous applyDecay result is fine too, since last_observed_at
 * never moves between observations) — never re-run applyDecay against its
 * own output for a *different* `now` expecting the days to add up; always
 * pass the same anchored belief with the new `now`.
 */
export function applyDecay(belief: SubtopicBelief, now: Date): SubtopicBelief {
  if (!belief.last_observed_at) return belief;

  const daysSince = daysBetween(belief.last_observed_at, now);
  if (daysSince <= 0) return belief;

  const strengthDays = computeStrengthDays(belief.mu, belief.confidence);
  const retentionEstimate = estimateRetention(belief.mu, belief.confidence, daysSince);
  const confidence = decayConfidence(belief.confidence, daysSince);

  return {
    ...belief,
    confidence,
    strength_days: strengthDays,
    retention_estimate: retentionEstimate,
  };
}
