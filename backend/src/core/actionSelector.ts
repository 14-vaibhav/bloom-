/**
 * Decides *what kind* of activity a subtopic needs next (bloom-phase4-brief
 * §4). Rule order is the whole point: retention only means something for
 * material that was once known, so `has_completed_learning` is gated *before*
 * the retention check. Applied in the PRD v3 order (retention first), a
 * subtopic the student has never opened — low mu, low confidence, therefore
 * low retention_estimate by construction — would be scheduled for
 * ACTIVE_RECALL instead of LEARN. Rule 1 (thin evidence -> a quick test
 * before committing hours of study) is the demo moment and must stay ahead
 * of rule 2's blanket LEARN.
 */

import { ACTION, RECALL } from "./constants.js";
import type { ActionSelectorInput, ActionType } from "./types.js";

export function selectAction(input: ActionSelectorInput): ActionType {
  if (
    input.evidence_count >= ACTION.immediate_test_min_evidence &&
    input.evidence_count < ACTION.immediate_test_max_evidence &&
    input.confidence < ACTION.immediate_test_max_confidence &&
    input.blueprint_weight > ACTION.immediate_test_min_blueprint_weight
  ) {
    return "IMMEDIATE_TEST";
  }

  if (!input.has_completed_learning) {
    return "LEARN";
  }

  if (input.retention_estimate < input.target_mastery * RECALL.retention_trigger_ratio) {
    return "ACTIVE_RECALL";
  }

  if (input.is_repeated_weakness) {
    return "REVISION";
  }

  if (input.mu < input.target_mastery) {
    return "PRACTICE";
  }

  if (input.mu >= input.target_mastery && input.all_learn_practice_complete && !input.has_final_test) {
    return "FINAL_TEST";
  }

  return "NONE";
}
