/**
 * Decides *when* recall is due — never *where* it fits on a calendar. That's
 * Phase 4's job; this module only ever emits RecallProposal.due_at, never a
 * scheduled start. checkPreemptiveRecall is the one that matters most for
 * the agency story (bloom-phase3-brief §6): it fires from a forecast, with
 * no failure event anywhere in its inputs.
 */

import { RECALL } from "./constants.js";
import type { RecallProposal } from "./types.js";
import { addDays } from "../lib/time.js";

export function scheduleAfterImmediateTest(subtopicId: string, testAt: Date): RecallProposal[] {
  return RECALL.base_intervals_days.map((days, index) => ({
    subtopic_id: subtopicId,
    due_at: addDays(testAt, days),
    urgency: RECALL.urgency_scheduled,
    reason: "scheduled_interval" as const,
    suggested_duration_min: RECALL.default_recall_duration_min,
    interval_index: index,
  }));
}

function multiplierFor(recallScore: number): number {
  if (recallScore >= RECALL.strong_threshold) return RECALL.multiplier_strong;
  if (recallScore >= RECALL.ok_threshold) return RECALL.multiplier_ok;
  return RECALL.multiplier_weak;
}

export function scheduleAfterRecall(
  subtopicId: string,
  recallAt: Date,
  recallScore: number,
  prevIntervalDays: number,
  intervalIndex: number,
): RecallProposal[] {
  const multiplier = multiplierFor(recallScore);
  const nextIntervalDays = Math.min(RECALL.max_interval_days, prevIntervalDays * multiplier);

  const proposals: RecallProposal[] = [
    {
      subtopic_id: subtopicId,
      due_at: addDays(recallAt, nextIntervalDays),
      urgency: recallScore < RECALL.ok_threshold ? RECALL.urgency_scheduled_after_weak_recall : RECALL.urgency_scheduled,
      reason: "scheduled_interval",
      suggested_duration_min: RECALL.default_recall_duration_min,
      interval_index: intervalIndex + 1,
    },
  ];

  if (recallScore < RECALL.ok_threshold) {
    proposals.push({
      subtopic_id: subtopicId,
      due_at: recallAt,
      urgency: RECALL.urgency_recall_failure,
      reason: "recall_failure",
      suggested_duration_min: RECALL.default_revision_duration_min,
      interval_index: intervalIndex,
    });
  }

  return proposals;
}

export type PreemptiveRecallInput = {
  subtopic_id: string;
  retention_estimate: number;
  target_mastery: number;
  blueprint_weight: number;
};

export function checkPreemptiveRecall(input: PreemptiveRecallInput, now: Date): RecallProposal | null {
  if (input.blueprint_weight <= RECALL.min_blueprint_weight_for_recall) return null;
  const trigger = input.target_mastery * RECALL.retention_trigger_ratio;
  if (input.retention_estimate >= trigger) return null;

  return {
    subtopic_id: input.subtopic_id,
    due_at: now,
    urgency: RECALL.urgency_retention_decay,
    reason: "retention_decay",
    suggested_duration_min: RECALL.default_recall_duration_min,
    interval_index: 0,
  };
}
