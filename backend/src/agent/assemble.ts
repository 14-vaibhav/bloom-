/**
 * ANALYZE / RETRIEVE glue (bloom-phase6-brief §6.2 phases 4 and 6) — the
 * bridge between tool outputs / raw reads and core/'s pure types. Nothing in
 * src/core may import this file (it would break the module-independence
 * guarantees core relies on); this file imports FROM core freely.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { concepts, learningActivities, questionAttempts, questions, resourceFeedback, resources, subtopicPrerequisites, subtopics, topics } from "../db/schema.js";
import { analyzeConceptWeakness } from "../core/concept.js";
import { computeDaysUntilNeeded } from "../core/gapEngine.js";
import { checkPreemptiveRecall } from "../core/recall.js";
import { rankResources } from "../core/resourceFit.js";
import type {
  GapEngineInput,
  LearningGoal,
  ResourceCandidate,
  ScoredResource,
  StudentConstraintsInput,
  SubtopicBelief,
  TopicGraph,
} from "../core/types.js";
import { callTool } from "../tools/dispatcher.js";
import type { AgentContext } from "../tools/context.js";
import type { ToolOutput } from "../tools/schemas.js";

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

/** All subtopics for a subject, plus their subtopic-level prerequisite edges and base hours
 * — the one thing the planner, gap engine, and validator all need and none of them fetch
 * themselves (core/ has no DB access at all — see planner.ts's header). */
export async function buildTopicGraph(subjectId: string): Promise<TopicGraph> {
  const rows = await db
    .select({ id: subtopics.id, baseHours: subtopics.baseHours })
    .from(subtopics)
    .innerJoin(topics, eq(subtopics.topicId, topics.id))
    .where(eq(topics.subjectId, subjectId));

  const subtopicIds = rows.map((r) => r.id);
  const baseHours: Record<string, number> = {};
  for (const r of rows) baseHours[r.id] = num(r.baseHours);

  const edges =
    subtopicIds.length > 0
      ? await db
          .select({ subtopicId: subtopicPrerequisites.subtopicId, prereqId: subtopicPrerequisites.prereqId })
          .from(subtopicPrerequisites)
          .where(inArray(subtopicPrerequisites.subtopicId, subtopicIds))
      : [];

  return {
    subtopic_ids: subtopicIds,
    prerequisites: edges.map((e) => ({ subtopic_id: e.subtopicId, prereq_id: e.prereqId })),
    base_hours: baseHours,
  };
}

/** Default blueprint for a fresh goal over an entire subject: each subtopic's weight is
 * topic_weight × subtopic_weight, which — since both already sum to 1.0 within their
 * parent (schema.ts's own comment on both columns) — sums to 1.0 across the whole subject
 * with no further normalisation. Shared by the onboarding route and the eval harness so
 * a synthetic student's blueprint is built exactly the same way a real one's is. */
export async function buildDefaultBlueprint(subjectId: string): Promise<{ blueprint: Record<string, number>; targetMastery: Record<string, number> }> {
  const rows = await db
    .select({ id: subtopics.id, weight: subtopics.weight, topicWeight: topics.weight })
    .from(subtopics)
    .innerJoin(topics, eq(subtopics.topicId, topics.id))
    .where(eq(topics.subjectId, subjectId));
  const blueprint: Record<string, number> = {};
  const targetMastery: Record<string, number> = {};
  for (const r of rows) {
    blueprint[r.id] = num(r.weight) * num(r.topicWeight);
    targetMastery[r.id] = 0.75;
  }
  return { blueprint, targetMastery };
}

/** Fixed concept tags are the Diagnostician's semantic boundary.  The LLM may
 * choose among these names, never invent a concept that cannot be attached to
 * an activity or assessment. */
export async function loadConceptTags(subtopicId: string): Promise<string[]> {
  const rows = await db.select({ id: concepts.id }).from(concepts).where(eq(concepts.subtopicId, subtopicId));
  const prefix = `${subtopicId}__`;
  return rows.map((row) => row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id).sort();
}

export function buildLearningGoal(goal: {
  subject_id: string;
  deadline: string;
  blueprint: Record<string, number>;
  target_mastery: Record<string, number>;
  must_have_subtopics: string[];
}): LearningGoal {
  return {
    subject_id: goal.subject_id,
    deadline: new Date(`${goal.deadline}T23:59:59.999Z`),
    blueprint: goal.blueprint,
    target_mastery: goal.target_mastery,
    must_have_subtopics: goal.must_have_subtopics,
  };
}

export function buildStudentConstraints(c: {
  weekly_availability: Record<string, Array<{ start: string; end: string }>>;
  max_daily_study_min: number;
  min_session_min: number;
  max_session_min: number;
  blackout_dates: string[];
}): StudentConstraintsInput {
  return {
    weekly_availability: c.weekly_availability,
    max_daily_study_min: c.max_daily_study_min,
    min_session_min: c.min_session_min,
    max_session_min: c.max_session_min,
    blackout_dates: c.blackout_dates,
  };
}

type SubtopicCompletionInfo = {
  has_completed_learning: boolean;
  all_learn_practice_complete: boolean;
  has_final_test: boolean;
  active_recall_completed_count: number;
};

/** One pass over the current plan version's activities, grouped by subtopic — avoids N
 * per-subtopic queries for the handful of booleans buildGapEngineInputs needs. */
export async function loadCompletionInfo(studentId: string, planId: string | null, planVersion: number | null, subtopicIds: string[]): Promise<Map<string, SubtopicCompletionInfo>> {
  const out = new Map<string, SubtopicCompletionInfo>();
  for (const id of subtopicIds) out.set(id, { has_completed_learning: false, all_learn_practice_complete: true, has_final_test: false, active_recall_completed_count: 0 });
  if (!planId || planVersion === null || subtopicIds.length === 0) return out;

  const rows = await db
    .select()
    .from(learningActivities)
    .where(and(eq(learningActivities.studentId, studentId), eq(learningActivities.planId, planId), eq(learningActivities.planVersion, planVersion), inArray(learningActivities.subtopicId, subtopicIds)));

  const anyPlannedLearnPractice = new Set<string>();
  for (const a of rows) {
    const info = out.get(a.subtopicId)!;
    if (a.action === "LEARN" && a.status === "completed") info.has_completed_learning = true;
    if ((a.action === "LEARN" || a.action === "PRACTICE") && a.status === "planned") anyPlannedLearnPractice.add(a.subtopicId);
    if (a.action === "FINAL_TEST") info.has_final_test = true;
    if (a.action === "ACTIVE_RECALL" && a.status === "completed") info.active_recall_completed_count += 1;
  }
  for (const id of subtopicIds) {
    out.get(id)!.all_learn_practice_complete = !anyPlannedLearnPractice.has(id);
  }
  return out;
}

function computeDependents(topicGraph: TopicGraph): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const id of topicGraph.subtopic_ids) dependents.set(id, []);
  for (const e of topicGraph.prerequisites) {
    if (!dependents.has(e.prereq_id)) dependents.set(e.prereq_id, []);
    dependents.get(e.prereq_id)!.push(e.subtopic_id);
  }
  return dependents;
}

/** Longest remaining chain of not-yet-mastered dependents starting at `id`, going forward —
 * gapEngine.ts's "position in the topological order" (§3.1). Memoized; the seed graph has
 * no cycles (Phase 1 validates this and planner.ts throws loudly if one ever appears). */
function computeTopologicalDepths(topicGraph: TopicGraph, beliefs: Map<string, SubtopicBelief>, goal: LearningGoal): Map<string, number> {
  const dependents = computeDependents(topicGraph);
  const memo = new Map<string, number>();
  const isUnmastered = (id: string) => {
    const b = beliefs.get(id);
    const target = goal.target_mastery[id] ?? 0;
    return !b || b.mu < target;
  };
  function depth(id: string, visiting: Set<string>): number {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0; // defensive cycle guard — should never trigger on a valid seed graph
    visiting.add(id);
    const deps = (dependents.get(id) ?? []).filter(isUnmastered);
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depth(dep, visiting)));
    visiting.delete(id);
    memo.set(id, d);
    return d;
  }
  const result = new Map<string, number>();
  for (const id of topicGraph.subtopic_ids) result.set(id, depth(id, new Set()));
  return result;
}

export type ConceptWeaknessBySubtopic = Map<string, boolean>; // subtopic_id -> is_repeated_weakness

/** Rolls per-attempt question errors up to "does this subtopic have at least one concept
 * the student has never learned" (core/concept.ts's is_repeated), blueprint-weighted per
 * concept's own subtopic. */
export async function computeRepeatedWeaknessBySubtopic(studentId: string, subtopicIds: string[], blueprint: Record<string, number>): Promise<ConceptWeaknessBySubtopic> {
  const out: ConceptWeaknessBySubtopic = new Map(subtopicIds.map((id) => [id, false]));
  if (subtopicIds.length === 0) return out;

  const rows = await db
    .select({ conceptId: questions.conceptId, subtopicId: questions.subtopicId, correct: questionAttempts.correct, at: questionAttempts.createdAt })
    .from(questionAttempts)
    .innerJoin(questions, eq(questions.id, questionAttempts.questionId))
    .where(and(eq(questionAttempts.studentId, studentId), inArray(questions.subtopicId, subtopicIds)));

  const byConcept = new Map<string, { subtopicId: string; attempts: Array<{ correct: boolean; at: Date }> }>();
  for (const r of rows) {
    if (!r.conceptId) continue;
    const entry = byConcept.get(r.conceptId) ?? { subtopicId: r.subtopicId, attempts: [] };
    entry.attempts.push({ correct: r.correct, at: r.at });
    byConcept.set(r.conceptId, entry);
  }

  for (const [conceptId, { subtopicId, attempts }] of byConcept) {
    const weakness = analyzeConceptWeakness(conceptId, subtopicId, attempts, blueprint[subtopicId] ?? 0);
    if (weakness.is_repeated) out.set(subtopicId, true);
  }
  return out;
}

export function buildGapEngineInputs(
  beliefs: Map<string, SubtopicBelief>,
  goal: LearningGoal,
  topicGraph: TopicGraph,
  completion: Map<string, SubtopicCompletionInfo>,
  repeatedWeakness: ConceptWeaknessBySubtopic,
  now: Date,
): GapEngineInput[] {
  const depths = computeTopologicalDepths(topicGraph, beliefs, goal);
  const dependents = computeDependents(topicGraph);
  const daysRemaining = Math.max(1, (goal.deadline.getTime() - now.getTime()) / 86_400_000);
  const candidateCount = Math.max(1, Object.keys(goal.blueprint).length);
  const avgDaysPerSubtopic = daysRemaining / candidateCount;

  const inputs: GapEngineInput[] = [];
  for (const subtopicId of Object.keys(goal.blueprint)) {
    const belief = beliefs.get(subtopicId);
    const targetMastery = goal.target_mastery[subtopicId] ?? 0.75;
    const unmasteredDependents = (dependents.get(subtopicId) ?? []).filter((dep) => {
      const b = beliefs.get(dep);
      const target = goal.target_mastery[dep] ?? 0;
      return !b || b.mu < target;
    }).length;
    const info = completion.get(subtopicId) ?? { has_completed_learning: false, all_learn_practice_complete: true, has_final_test: false, active_recall_completed_count: 0 };

    inputs.push({
      subtopic_id: subtopicId,
      mu: belief?.mu ?? 0,
      confidence: belief?.confidence ?? 0,
      learn_rate: belief?.learn_rate ?? 0.1,
      target_mastery: targetMastery,
      blueprint_weight: goal.blueprint[subtopicId] ?? 0,
      retention_estimate: belief?.retention_estimate ?? 0,
      unmastered_dependent_count: unmasteredDependents,
      days_until_needed: computeDaysUntilNeeded(now, goal.deadline, depths.get(subtopicId) ?? 0, avgDaysPerSubtopic),
      evidence_count: belief?.evidence_count ?? 0,
      has_completed_learning: info.has_completed_learning,
      is_repeated_weakness: repeatedWeakness.get(subtopicId) ?? false,
      all_learn_practice_complete: info.all_learn_practice_complete,
      has_final_test: info.has_final_test,
    });
  }
  return inputs;
}

/** Subtopics whose retention forecast has fallen below target x0.8 THIS tick — the
 * pre-emptive recall signal (§6, recall.ts's checkPreemptiveRecall) that fires from a
 * forecast, before anything has failed. */
export function findPreemptiveRecallSubtopics(beliefs: Map<string, SubtopicBelief>, goal: LearningGoal, now: Date): string[] {
  const out: string[] = [];
  for (const [id, belief] of beliefs) {
    const weight = goal.blueprint[id];
    if (weight === undefined) continue;
    const proposal = checkPreemptiveRecall(
      { subtopic_id: id, retention_estimate: belief.retention_estimate, target_mastery: goal.target_mastery[id] ?? 0.75, blueprint_weight: weight },
      now,
    );
    if (proposal) out.push(id);
  }
  return out;
}

/** RETRIEVE for one subtopic: search live, live-verified candidates, exclude anything the
 * student already finished for this subtopic, and rank by pedagogical fit. Returns an empty
 * list (not an error) when RAG comes back empty or degraded with nothing usable — the
 * planner already treats "no resource" as PRACTICE-from-question-bank, never a hard stop. */
export async function retrieveResourcesForSubtopic(
  ctx: AgentContext,
  studentId: string,
  subtopicId: string,
  belief: SubtopicBelief,
  targetDifficulty: number,
  slotMinutes: number,
): Promise<ScoredResource[]> {
  const consumedRows = await db
    .select({ resourceId: learningActivities.resourceId })
    .from(learningActivities)
    .where(and(eq(learningActivities.studentId, studentId), eq(learningActivities.subtopicId, subtopicId), eq(learningActivities.status, "completed")));
  const excludeIds = [...new Set(consumedRows.map((r) => r.resourceId).filter((id): id is string => id !== null))];

  const badFeedback = await db
    .select({ resourceId: resourceFeedback.resourceId })
    .from(resourceFeedback)
    .where(and(eq(resourceFeedback.studentId, studentId), inArray(resourceFeedback.rating, ["unhelpful", "dead_link"])));
  const blacklisted = new Set(badFeedback.map((r) => r.resourceId));

  let hits: ToolOutput<"rag.search_learning_resources"> = [];
  try {
    hits = await callTool(ctx, "rag.search_learning_resources", {
      subtopic_id: subtopicId,
      target_difficulty: targetDifficulty as 1 | 2 | 3 | 4 | 5,
      max_duration_min: Math.max(10, slotMinutes),
      exclude_ids: excludeIds,
      k: 8,
    });
  } catch {
    return [];
  }
  if (hits.length === 0) return [];

  const candidates: ResourceCandidate[] = hits.map((h) => ({
    id: h.id,
    type: h.type,
    difficulty: h.difficulty as 1 | 2 | 3 | 4 | 5,
    duration_min: h.duration_min,
    quality: h.quality,
    blacklisted: blacklisted.has(h.id),
    already_consumed: false, // excluded at the RAG call itself — see exclude_ids above
    covers_focus_concept: false,
  }));

  return rankResources(candidates, belief.mu, slotMinutes, belief.format_efficacy, 3);
}

/** resource_id -> duration_min for every resource referenced by a plan, for the validator's
 * C4 (a resource_id the DB no longer recognises is simply skipped, per ValidatorState's own
 * contract — "can't fail a check it has no data for"). */
export async function loadResourceDurations(resourceIds: string[]): Promise<Record<string, number>> {
  const ids = [...new Set(resourceIds)];
  if (ids.length === 0) return {};
  const rows = await db.select({ id: resources.id, durationMin: resources.durationMin }).from(resources).where(inArray(resources.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.durationMin]));
}
