/**
 * The belief updater. Confidence only ever increases here — it decreases
 * only through decay.ts. That asymmetry is deliberate: a bad quiz result is
 * still evidence, so confidence rises even as mu falls (bloom-phase3-brief
 * §4.3 — the canonical case: mu drops 0.68→0.581 while confidence rises
 * 0.55→0.775).
 *
 * Idempotency (§4.7): the real dedup lives in a DB unique constraint Phase 6
 * adds to mastery_observations. This function accepts the same check in pure
 * form — pass the set of already-applied source_ids and a repeat is a no-op
 * — so it's covered by tests now instead of only once persistence exists.
 */

import { BELIEF } from "./constants.js";
import type { BeliefDelta, Observation, SubtopicBelief } from "./types.js";
import { clamp, hoursBetween } from "./util.js";

export function applyObservation(
  belief: SubtopicBelief,
  obs: Observation,
  now: Date,
  appliedSourceIds?: ReadonlySet<string>,
): { belief: SubtopicBelief; delta: BeliefDelta | null } {
  if (appliedSourceIds?.has(obs.source_id)) {
    return { belief, delta: null };
  }

  const reliability = BELIEF.difficulty_reliability[obs.difficulty];
  const difficultyFactor = BELIEF.difficulty_factor[obs.difficulty];

  const w = Math.min(1, (obs.n / BELIEF.evidence_saturation) * reliability);
  const sAdj = clamp(obs.score * difficultyFactor, 0, 1);
  const alpha = BELIEF.alpha_base + BELIEF.alpha_uncertainty * (1 - belief.confidence);

  const muBefore = belief.mu;
  const muAfter = clamp(belief.mu + alpha * w * (sAdj - belief.mu), 0, 1);

  const confidenceBefore = belief.confidence;
  const confidenceAfter = clamp(1 - (1 - belief.confidence) * (1 - BELIEF.confidence_gain * w), 0, 1);

  const hoursSinceLastObservation = belief.last_observed_at ? hoursBetween(belief.last_observed_at, now) : 0;
  const canRecalibrate = belief.last_observed_at !== null && hoursSinceLastObservation >= BELIEF.min_hours_for_recalibration;

  const learnRateBefore = belief.learn_rate;
  let learnRateAfter = belief.learn_rate;
  if (canRecalibrate) {
    const predictedGain = belief.learn_rate * hoursSinceLastObservation;
    const actualGain = muAfter - belief.mu_at_last_observation;
    const ratio = actualGain / Math.max(predictedGain, BELIEF.min_predicted_gain);
    const [lo, hi] = BELIEF.learn_rate_bounds;
    learnRateAfter = clamp(
      belief.learn_rate * (BELIEF.recalibration_damping + BELIEF.recalibration_damping * ratio),
      lo,
      hi,
    );
  }

  let formatEfficacyAfter = belief.format_efficacy;
  if (canRecalibrate && obs.format_hours) {
    const actualGain = muAfter - belief.mu_at_last_observation;
    const totalHours = Object.values(obs.format_hours).reduce((sum, h) => sum + (h ?? 0), 0);
    if (totalHours > 0) {
      formatEfficacyAfter = { ...belief.format_efficacy };
      for (const [format, hoursInFormat] of Object.entries(obs.format_hours) as [keyof typeof formatEfficacyAfter, number | undefined][]) {
        if (!hoursInFormat || hoursInFormat <= 0) continue;
        const gainPerHour = (actualGain * (hoursInFormat / totalHours)) / Math.max(hoursInFormat, BELIEF.min_format_hours);
        formatEfficacyAfter[format] =
          (1 - BELIEF.format_efficacy_ema_alpha) * belief.format_efficacy[format] + BELIEF.format_efficacy_ema_alpha * gainPerHour;
      }
    }
  }

  let predictionError: number | undefined;
  let predictionErrorEmaAfter = belief.prediction_error_ema;
  let significant = false;
  if (obs.predicted_score !== undefined) {
    predictionError = obs.score - obs.predicted_score;
    predictionErrorEmaAfter =
      (1 - BELIEF.prediction_error_ema_alpha) * belief.prediction_error_ema + BELIEF.prediction_error_ema_alpha * predictionError;
    significant = Math.abs(predictionError) > BELIEF.prediction_error_threshold;
  }

  const newBelief: SubtopicBelief = {
    ...belief,
    mu: muAfter,
    confidence: confidenceAfter,
    learn_rate: learnRateAfter,
    evidence_count: belief.evidence_count + obs.n,
    assessment_count: belief.assessment_count + 1,
    last_observed_at: now,
    mu_at_last_observation: muAfter,
    hours_since_last_observation: 0,
    prediction_error_ema: predictionErrorEmaAfter,
    format_efficacy: formatEfficacyAfter,
  };

  const delta: BeliefDelta = {
    applied: true,
    mu_before: muBefore,
    mu_after: muAfter,
    confidence_before: confidenceBefore,
    confidence_after: confidenceAfter,
    learn_rate_before: learnRateBefore,
    learn_rate_after: learnRateAfter,
    prediction_error: predictionError,
    significant,
  };

  return { belief: newBelief, delta };
}
