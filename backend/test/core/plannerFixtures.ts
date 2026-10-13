import type { LearningGoal, RecallProposal, ScoredResource, SubtopicBelief, TopicGraph } from "../../src/core/types.js";
import { makeBelief } from "./fixtures.js";

/** A 3-subtopic chain a -> b -> c (b depends on a, c depends on b), small enough to reason
 * about by hand and used across the planner property/determinism tests. */
export const CHAIN_IDS = ["p_a", "p_b", "p_c"] as const;

export function makeTopicGraph(baseHours: Record<string, number> = { p_a: 2, p_b: 2, p_c: 2 }): TopicGraph {
  return {
    subtopic_ids: [...CHAIN_IDS],
    prerequisites: [
      { subtopic_id: "p_b", prereq_id: "p_a" },
      { subtopic_id: "p_c", prereq_id: "p_b" },
    ],
    base_hours: baseHours,
  };
}

export function makeGoal(overrides: Partial<LearningGoal> = {}): LearningGoal {
  return {
    subject_id: "dsa",
    deadline: new Date("2026-12-31T00:00:00Z"),
    blueprint: { p_a: 0.3, p_b: 0.3, p_c: 0.4 },
    target_mastery: { p_a: 0.75, p_b: 0.75, p_c: 0.75 },
    must_have_subtopics: [],
    ...overrides,
  };
}

export function makePlannerBelief(id: string, overrides: Partial<SubtopicBelief> = {}): SubtopicBelief {
  return makeBelief({ subtopic_id: id, ...overrides });
}

export function makeResourceMap(ids: readonly string[]): Map<string, ScoredResource[]> {
  const map = new Map<string, ScoredResource[]>();
  for (const id of ids) {
    map.set(id, [
      {
        resource_id: `res_${id}_1`,
        fit: 0.8,
        breakdown: { level_match: 0.9, duration_fit: 1, quality: 0.8, format_match: 0.7, novelty: 1, concept_hit: 0.5 },
      },
    ]);
  }
  return map;
}

export function makeRecallProposal(subtopicId: string, dueAt: Date, overrides: Partial<RecallProposal> = {}): RecallProposal {
  return {
    subtopic_id: subtopicId,
    due_at: dueAt,
    urgency: 0.5,
    reason: "scheduled_interval",
    suggested_duration_min: 15,
    interval_index: 0,
    ...overrides,
  };
}
