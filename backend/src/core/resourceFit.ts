/**
 * Scores a candidate resource against a specific slot and student
 * (bloom-phase4-brief §5). `format_match` is where the student model leaks
 * into resource choice — it's the factor that produces the best explanation
 * line in the demo ("your mastery gain per hour is 4.7x higher from
 * practice than video"). Guard the denominator: if every format_efficacy is
 * still at its default, every format scores the same and the factor drops
 * out, which is correct for a student with no history yet.
 */

import { RESOURCE_FIT } from "./constants.js";
import type { FormatEfficacy, ResourceCandidate, ResourceFitBreakdown, ScoredResource } from "./types.js";
import { clamp } from "./util.js";

function levelMatch(difficulty: number, mu: number): number {
  return 1 - Math.abs(difficulty / 5 - (mu + RESOURCE_FIT.zpd_offset));
}

function durationFit(durationMin: number, slotMinutes: number): number {
  const softCap = slotMinutes * RESOURCE_FIT.duration_soft_cap_ratio;
  if (durationMin <= softCap) return 1;
  return Math.max(0, 1 - (durationMin - softCap) / slotMinutes);
}

function formatMatch(type: ResourceCandidate["type"], formatEfficacy: FormatEfficacy): number {
  const values = Object.values(formatEfficacy);
  const max = Math.max(...values);
  if (max <= 0) return 1;
  return formatEfficacy[type] / max;
}

function noveltyOf(candidate: ResourceCandidate): number {
  if (candidate.blacklisted) return RESOURCE_FIT.novelty_blacklisted;
  if (candidate.already_consumed) return RESOURCE_FIT.novelty_consumed;
  return RESOURCE_FIT.novelty_fresh;
}

export function scoreResourceFit(
  candidate: ResourceCandidate,
  mu: number,
  slotMinutes: number,
  formatEfficacy: FormatEfficacy,
): ScoredResource {
  const breakdown: ResourceFitBreakdown = {
    level_match: levelMatch(candidate.difficulty, mu),
    duration_fit: durationFit(candidate.duration_min, slotMinutes),
    quality: candidate.quality,
    format_match: formatMatch(candidate.type, formatEfficacy),
    novelty: noveltyOf(candidate),
    concept_hit: candidate.covers_focus_concept ? RESOURCE_FIT.concept_hit_match : RESOURCE_FIT.concept_hit_default,
  };

  const w = RESOURCE_FIT.weights;
  const fit =
    w.level_match * breakdown.level_match +
    w.duration_fit * breakdown.duration_fit +
    w.quality * breakdown.quality +
    w.format_match * breakdown.format_match +
    w.novelty * breakdown.novelty +
    w.concept_hit * breakdown.concept_hit;

  return { resource_id: candidate.id, fit: clamp(fit, 0, 1), breakdown };
}

/** Returns the top `topN` candidates with their per-factor breakdown, ranked by fit descending,
 * tie-broken by resource id ascending (§8 — every sort needs an explicit tie-break). */
export function rankResources(
  candidates: ResourceCandidate[],
  mu: number,
  slotMinutes: number,
  formatEfficacy: FormatEfficacy,
  topN = 3,
): ScoredResource[] {
  return candidates
    .map((c) => scoreResourceFit(c, mu, slotMinutes, formatEfficacy))
    .sort((a, b) => b.fit - a.fit || a.resource_id.localeCompare(b.resource_id))
    .slice(0, topN);
}
