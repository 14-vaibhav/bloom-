/**
 * Ranks subtopics by how much attention they deserve (bloom-phase4-brief
 * §3). PRD v3 weighted the raw factors directly, but `severity` is a
 * product of two sub-1.0 numbers while `urgency` and `learnability` arrive
 * as raw 0-1 values — so severity contributes almost nothing and the
 * ranking ends up driven by whichever factor happens to have the largest
 * raw scale, not by how badly a subtopic is known. §3.2's fix is min-max
 * normalisation across the candidate set before weighting.
 *
 * priority is relative to the current candidate set only. Never store it as
 * an absolute or compare it across plan versions — store gap_snapshot (the
 * raw, pre-normalisation factors) if a historical record is needed.
 */

import { GAP } from "./constants.js";
import { selectAction } from "./actionSelector.js";
import type { GapEngineInput, GapEntry, GapFactors } from "./types.js";
import { clamp, daysBetween } from "./util.js";

function computeRawFactors(input: GapEngineInput, maxLearnRate: number): GapFactors {
  const gap = Math.max(0, input.target_mastery - input.mu);
  const severity = gap * input.blueprint_weight;
  const blockingFactor = 1 + GAP.blocking_factor_per_dependent * input.unmastered_dependent_count;
  const blocking_term = severity * (blockingFactor - 1);
  const urgency = 1 / (1 + input.days_until_needed / GAP.urgency_days_scale);
  const learnability = maxLearnRate > 0 ? input.learn_rate / maxLearnRate : 0;
  const uncertainty = (1 - input.confidence) * GAP.uncertainty_scale;
  const retention_risk = Math.max(0, input.target_mastery - input.retention_estimate) * input.blueprint_weight;

  return { gap, severity, blocking_term, urgency, learnability, uncertainty, retention_risk };
}

/** Min-max normalise one factor across the candidate set. An all-equal column carries no
 * ranking signal, so it normalises to a flat 0.5 rather than dividing by zero. */
function normalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range < GAP.min_max_epsilon) return values.map(() => 0.5);
  return values.map((v) => (v - min) / range);
}

/**
 * Ranks every candidate subtopic and attaches its selected action in one
 * pass, so the two never drift apart in a caller that forgets to call
 * selectAction separately. Order of the returned array is NOT the plan
 * order — the planner topologically sorts and tie-breaks by subtopic_id.
 */
export function buildGapTable(inputs: GapEngineInput[]): GapEntry[] {
  if (inputs.length === 0) return [];

  const maxLearnRate = Math.max(...inputs.map((i) => i.learn_rate));
  const raw = inputs.map((i) => computeRawFactors(i, maxLearnRate));

  const normSeverity = normalize(raw.map((r) => r.severity));
  const normBlocking = normalize(raw.map((r) => r.blocking_term));
  const normUrgency = normalize(raw.map((r) => r.urgency));
  const normLearnability = normalize(raw.map((r) => r.learnability));
  const normUncertainty = normalize(raw.map((r) => r.uncertainty));
  const normRetention = normalize(raw.map((r) => r.retention_risk));

  const w = GAP.weights;

  return inputs.map((input, i) => {
    const priority =
      100 *
      (w.severity * normSeverity[i] +
        w.blocking * normBlocking[i] +
        w.urgency * normUrgency[i] +
        w.learnability * normLearnability[i] +
        w.uncertainty * normUncertainty[i] +
        w.retention_risk * normRetention[i]);

    const action = selectAction({
      evidence_count: input.evidence_count,
      confidence: input.confidence,
      blueprint_weight: input.blueprint_weight,
      has_completed_learning: input.has_completed_learning,
      retention_estimate: input.retention_estimate,
      target_mastery: input.target_mastery,
      is_repeated_weakness: input.is_repeated_weakness,
      mu: input.mu,
      all_learn_practice_complete: input.all_learn_practice_complete,
      has_final_test: input.has_final_test,
    });

    return {
      subtopic_id: input.subtopic_id,
      priority: clamp(priority, 0, 100),
      action,
      gap_snapshot: raw[i],
    };
  });
}

/**
 * days_until_needed (§3.1): a subtopic that gates three others needs to be
 * done earlier than one that gates none, so its deadline is pulled forward
 * by its position in the topological order.
 */
export function computeDaysUntilNeeded(
  now: Date,
  deadline: Date,
  remainingTopologicalDepth: number,
  averageDaysPerSubtopic: number,
): number {
  return daysBetween(now, deadline) - remainingTopologicalDepth * averageDaysPerSubtopic;
}
