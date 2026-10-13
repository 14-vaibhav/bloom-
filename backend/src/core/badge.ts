/**
 * The mastery badge (§9). Because confidence and staleness both move with
 * elapsed time alone, a green badge can demote itself to amber with no new
 * input at all — nothing failed, nothing was studied, the agent just became
 * less sure. Amber always carries the failing reason(s) as human sentences.
 */

import { MASTERY_BADGE } from "./constants.js";
import type { MasteryBadgeResult, SubtopicBelief } from "./types.js";
import { daysBetween } from "./util.js";

export type MasteryBadgeContext = {
  assessment_count: number;
  had_assessment_at_or_above_target_difficulty: boolean;
};

export function computeMasteryBadge(
  belief: SubtopicBelief,
  targetMastery: number,
  now: Date,
  context: MasteryBadgeContext,
): MasteryBadgeResult {
  if (belief.mu < targetMastery * MASTERY_BADGE.min_mu_ratio) {
    return { level: "grey", reasons: [] };
  }

  const daysSinceObservation = belief.last_observed_at ? daysBetween(belief.last_observed_at, now) : Infinity;

  const reasons: string[] = [];
  if (belief.confidence < MASTERY_BADGE.min_confidence) {
    reasons.push(`${belief.mu.toFixed(2)} mastery, but confidence is only ${belief.confidence.toFixed(2)}.`);
  }
  if (context.assessment_count < MASTERY_BADGE.min_assessments) {
    reasons.push(`${belief.mu.toFixed(2)} mastery, but only ${context.assessment_count} assessment(s) so far.`);
  }
  if (!context.had_assessment_at_or_above_target_difficulty) {
    reasons.push(`${belief.mu.toFixed(2)} mastery, but never assessed at or above the target difficulty.`);
  }
  if (daysSinceObservation > MASTERY_BADGE.max_staleness_days) {
    reasons.push(`${belief.mu.toFixed(2)} mastery, but last measured ${Math.floor(daysSinceObservation)} days ago.`);
  }

  if (reasons.length === 0) return { level: "green", reasons: [] };
  return { level: "amber", reasons };
}
