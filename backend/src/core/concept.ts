/**
 * Rolls per-attempt question errors up into a concept-level diagnosis (§8).
 * is_repeated ("never learned this") and is_forgotten ("knew it, lost it")
 * are deliberately distinct flags — they call for different interventions,
 * and collapsing them loses the diagnosis that makes this engine worth
 * having.
 */

import { CONCEPT } from "./constants.js";
import type { ConceptAttempt, ConceptWeakness } from "./types.js";

function accuracyOf(attempts: ConceptAttempt[]): number {
  if (attempts.length === 0) return 0;
  return attempts.filter((a) => a.correct).length / attempts.length;
}

function trailingIncorrectStreak(sorted: ConceptAttempt[]): number {
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].correct) break;
    streak++;
  }
  return streak;
}

export function analyzeConceptWeakness(
  concept: string,
  subtopicId: string,
  attempts: ConceptAttempt[],
  blueprintWeight: number,
): ConceptWeakness {
  const sorted = [...attempts].sort((a, b) => a.at.getTime() - b.at.getTime());
  const accuracy = accuracyOf(sorted);
  const isRepeated = sorted.length >= CONCEPT.repeated_min_attempts && accuracy < CONCEPT.repeated_max_accuracy;

  const recentWindow = sorted.slice(-CONCEPT.forgotten_recent_window);
  const priorWindow = sorted.slice(0, Math.max(0, sorted.length - recentWindow.length));
  const isForgotten =
    priorWindow.length >= CONCEPT.forgotten_min_prior_attempts &&
    accuracyOf(priorWindow) >= CONCEPT.forgotten_prior_min_accuracy &&
    accuracyOf(recentWindow) < CONCEPT.forgotten_recent_max_accuracy;

  const severity = (1 - accuracy) * Math.min(1, sorted.length / CONCEPT.severity_attempts_saturation) * blueprintWeight;

  return {
    concept,
    subtopic_id: subtopicId,
    accuracy,
    attempts: sorted.length,
    consecutive_failures: trailingIncorrectStreak(sorted),
    severity,
    is_repeated: isRepeated,
    is_forgotten: isForgotten,
  };
}

export function rankConceptWeaknesses(weaknesses: ConceptWeakness[]): ConceptWeakness[] {
  return [...weaknesses].sort((a, b) => b.severity - a.severity);
}
