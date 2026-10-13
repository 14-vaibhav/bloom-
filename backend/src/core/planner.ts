/**
 * Assembles beliefs, gaps, slots and resources into a sequence of activities
 * with predictions (bloom-phase4-brief §7).
 *
 * THE PLANNER IS BEST-EFFORT. THE VALIDATOR IS AUTHORITATIVE (§2). This
 * function respects the constraints it can respect cheaply — capacity as it
 * fills, prerequisites via topological order, deadlines as a filter on
 * candidate slots — and lets edge cases through: a recall proposal that
 * can't find a slot before its subtopic's cutoff, a deficit day, a final
 * test that doesn't fit. Phase 5's validator is what catches those, and
 * Phase 5 needs real failures to catch — a planner that tries to enforce
 * every constraint itself is a constraint solver we don't have time to
 * write, and it also destroys the demo's clearest evidence that validation
 * + repair actually does something. Do not "fix" this by making the fill
 * loop smarter about edge cases; make the validator smarter instead.
 *
 * Everything arrives as a parameter. No DB, no tool calls, no LLM, no
 * Math.random / Date.now — see §8 on determinism.
 */

import { PLANNER, RECALL } from "./constants.js";
import type {
  Activity,
  ActionType,
  BusyInterval,
  DegradedSignal,
  GapEntry,
  LearningGoal,
  Plan,
  PlanProjection,
  RecallProposal,
  ScoredResource,
  Slot,
  SubtopicBelief,
  TopicGraph,
} from "./types.js";
import { clamp } from "./util.js";

export type BuildPlanInput = {
  goal: LearningGoal;
  beliefs: SubtopicBelief[];
  gapTable: GapEntry[];
  slots: Slot[];
  resourceCandidates: Map<string, ScoredResource[]>;
  recallProposals: RecallProposal[];
  topicGraph: TopicGraph;
  simNow: Date;
  degradedSignals: DegradedSignal[];
};

const STUDY_ACTIONS = new Set<ActionType>(["LEARN", "PRACTICE"]);

function predictedScore(mu: number, learnRate: number, durationMin: number): number {
  const hours = durationMin / 60;
  return clamp(mu + learnRate * hours, 0, PLANNER.max_predicted_score);
}

/**
 * Layers the candidate subtopics by topological depth (prerequisites only
 * count when the prerequisite is itself a candidate), sorts each layer by
 * priority descending with subtopic_id ascending as the tie-break (§8 —
 * every sort needs an explicit tie-break), and concatenates. Throws on a
 * cycle rather than looping forever — a cycle reaching here means Phase 1's
 * seed validation missed something, and that should fail loudly, not hang.
 */
function topologicalPriorityOrder(gapTable: GapEntry[], topicGraph: TopicGraph): string[] {
  const candidateIds = new Set(gapTable.filter((g) => g.action !== "NONE").map((g) => g.subtopic_id));
  const priorityById = new Map(gapTable.map((g) => [g.subtopic_id, g.priority]));

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of candidateIds) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const edge of topicGraph.prerequisites) {
    if (!candidateIds.has(edge.subtopic_id) || !candidateIds.has(edge.prereq_id)) continue;
    inDegree.set(edge.subtopic_id, (inDegree.get(edge.subtopic_id) ?? 0) + 1);
    dependents.get(edge.prereq_id)!.push(edge.subtopic_id);
  }

  const remaining = new Set(candidateIds);
  const order: string[] = [];
  while (remaining.size > 0) {
    const layer = [...remaining]
      .filter((id) => (inDegree.get(id) ?? 0) === 0)
      .sort((a, b) => (priorityById.get(b)! - priorityById.get(a)!) || a.localeCompare(b));

    if (layer.length === 0) {
      throw new Error(`Cycle detected in subtopic prerequisite graph among: ${[...remaining].sort().join(", ")}`);
    }

    for (const id of layer) {
      order.push(id);
      remaining.delete(id);
      for (const dep of dependents.get(id) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) - 1);
      }
    }
  }

  return order;
}

function sortedResourceCandidates(resourceCandidates: Map<string, ScoredResource[]>, subtopicId: string): ScoredResource[] {
  const list = resourceCandidates.get(subtopicId) ?? [];
  return [...list].sort((a, b) => b.fit - a.fit || a.resource_id.localeCompare(b.resource_id));
}

function sortSlots(slots: Slot[]): Slot[] {
  return [...slots].sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
}

/** True when every prerequisite of `subtopicId` that has already been (fully) processed
 * finished strictly before `slotStart`. Prerequisites outside the candidate set, or with
 * no activities of their own, impose no constraint — see the file header on best-effort. */
function prereqsClearBefore(
  subtopicId: string,
  slotStart: Date,
  prereqsOf: Map<string, string[]>,
  lastScheduledEnd: Map<string, Date>,
): boolean {
  for (const prereqId of prereqsOf.get(subtopicId) ?? []) {
    const lastEnd = lastScheduledEnd.get(prereqId);
    if (lastEnd && lastEnd.getTime() > slotStart.getTime()) return false;
  }
  return true;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function buildPlan(input: BuildPlanInput): Plan {
  const { goal, beliefs, gapTable, topicGraph, simNow, degradedSignals } = input;

  const beliefById = new Map(beliefs.map((b) => [b.subtopic_id, b]));
  const gapById = new Map(gapTable.map((g) => [g.subtopic_id, g]));
  const prereqsOf = new Map<string, string[]>();
  for (const edge of topicGraph.prerequisites) {
    if (!prereqsOf.has(edge.subtopic_id)) prereqsOf.set(edge.subtopic_id, []);
    prereqsOf.get(edge.subtopic_id)!.push(edge.prereq_id);
  }

  const substituteLearnWithPractice = degradedSignals.includes("SUBSTITUTE_ACTIVITY_TYPE");
  const forceProvisional = degradedSignals.includes("PROVISIONAL_PLAN");
  const deferAssessments = degradedSignals.includes("DEFER_ASSESSMENTS");
  const assessmentEarliestStart = deferAssessments ? new Date(simNow.getTime() + 86_400_000) : simNow;

  // ---- Step 1: budget ----------------------------------------------------
  const hoursNeeded = new Map<string, number>();
  for (const gapEntry of gapTable) {
    if (!STUDY_ACTIONS.has(gapEntry.action)) continue;
    const belief = beliefById.get(gapEntry.subtopic_id);
    const baseHours = topicGraph.base_hours[gapEntry.subtopic_id] ?? 1;
    const learnRate = belief?.learn_rate ?? 0.1;
    const raw = gapEntry.gap_snapshot.gap / Math.max(learnRate, 1e-6);
    hoursNeeded.set(gapEntry.subtopic_id, clamp(raw, PLANNER.min_hours_per_subtopic, baseHours * PLANNER.max_hours_multiplier));
  }
  const totalNeeded = [...hoursNeeded.values()].reduce((sum, h) => sum + h, 0);
  const totalAvailable = input.slots.reduce((sum, s) => sum + s.duration_min, 0) / 60;
  const deficitHours = totalNeeded - totalAvailable;

  // ---- Step 2: order -------------------------------------------------------
  const studyOrder = topologicalPriorityOrder(gapTable, topicGraph).filter((id) => STUDY_ACTIONS.has(gapById.get(id)!.action));

  // ---- Step 3: greedy fill --------------------------------------------------
  let availableSlots = sortSlots(input.slots);
  const activities: Activity[] = [];
  const unplacedHours: Record<string, number> = {};
  const lastScheduledEnd = new Map<string, Date>();
  const lastLearnEnd = new Map<string, Date>();

  // Tracks each subtopic's mastery as the plan itself progresses, so a subtopic split
  // across several sessions shows a rising trajectory instead of every session
  // independently predicting from the same pre-plan mu (which reads as "day 4 still
  // predicts the same score as day 1" — not sensible, per §10's read-it-yourself check).
  // This is the same linear mu + learn_rate*hours model Step 6 uses in aggregate; here
  // it is just applied incrementally, activity by activity, for every action type.
  const runningMu = new Map<string, number>();
  function scoreAndAdvance(subtopicId: string, durationMin: number): number {
    const current = runningMu.get(subtopicId) ?? beliefById.get(subtopicId)?.mu ?? 0;
    const learnRate = beliefById.get(subtopicId)?.learn_rate ?? 0.1;
    const score = predictedScore(current, learnRate, durationMin);
    runningMu.set(subtopicId, score);
    return score;
  }

  for (const subtopicId of studyOrder) {
    const gapEntry = gapById.get(subtopicId)!;
    const effectiveAction: ActionType = substituteLearnWithPractice && gapEntry.action === "LEARN" ? "PRACTICE" : gapEntry.action;

    let remainingHours = hoursNeeded.get(subtopicId) ?? 0;
    let guard = 0;

    while (remainingHours > 1e-9) {
      guard++;
      if (guard > PLANNER.fill_loop_guard) {
        unplacedHours[subtopicId] = (unplacedHours[subtopicId] ?? 0) + remainingHours;
        break;
      }

      const slotIdx = availableSlots.findIndex(
        (s) => s.start.getTime() < goal.deadline.getTime() && prereqsClearBefore(subtopicId, s.start, prereqsOf, lastScheduledEnd),
      );
      if (slotIdx === -1) {
        unplacedHours[subtopicId] = (unplacedHours[subtopicId] ?? 0) + remainingHours;
        break;
      }

      const slot = availableSlots[slotIdx];
      availableSlots = [...availableSlots.slice(0, slotIdx), ...availableSlots.slice(slotIdx + 1)];

      const resourceId = effectiveAction === "PRACTICE" && gapEntry.action === "LEARN" ? null : sortedResourceCandidates(input.resourceCandidates, subtopicId)[0]?.resource_id ?? null;
      const score = scoreAndAdvance(subtopicId, slot.duration_min);

      activities.push({
        subtopic_id: subtopicId,
        resource_id: resourceId,
        action: effectiveAction,
        start: slot.start,
        end: slot.end,
        duration_min: slot.duration_min,
        priority: gapEntry.priority,
        predicted_score: score,
        expected_mastery_after: score,
        provisional: forceProvisional,
      });

      lastScheduledEnd.set(subtopicId, slot.end);
      if (gapEntry.action === "LEARN") lastLearnEnd.set(subtopicId, slot.end);
      remainingHours -= slot.duration_min / 60;
    }
  }

  // ---- Step 4: assessments and recall ---------------------------------------

  /** Best-effort: finds the earliest slot at/after `notBefore` (and before the goal
   * deadline) whose prerequisites for `subtopicId` are clear, takes only the first
   * `durationMin` of it, and pushes any usable remainder back into the pool. Returns
   * null (nothing scheduled) when no slot qualifies — see the file header on §2. */
  function placeShortActivity(
    subtopicId: string,
    action: ActionType,
    durationMin: number,
    notBefore: Date,
    sameDayAsEnd?: Date,
  ): Activity | null {
    const dayFilter = sameDayAsEnd ? (s: Slot) => isoDay(s.start) === isoDay(sameDayAsEnd) : () => true;

    let slotIdx = availableSlots.findIndex(
      (s) =>
        s.start.getTime() >= notBefore.getTime() &&
        s.start.getTime() < goal.deadline.getTime() &&
        s.duration_min >= durationMin &&
        prereqsClearBefore(subtopicId, s.start, prereqsOf, lastScheduledEnd) &&
        dayFilter(s),
    );
    if (slotIdx === -1 && sameDayAsEnd) {
      // fall back to the nearest slot on/after the trigger, any day
      slotIdx = availableSlots.findIndex(
        (s) =>
          s.start.getTime() >= notBefore.getTime() &&
          s.start.getTime() < goal.deadline.getTime() &&
          s.duration_min >= durationMin &&
          prereqsClearBefore(subtopicId, s.start, prereqsOf, lastScheduledEnd),
      );
    }
    if (slotIdx === -1) return null;

    const slot = availableSlots[slotIdx];
    const score = scoreAndAdvance(subtopicId, durationMin);
    const usedEnd = new Date(slot.start.getTime() + durationMin * 60_000);

    const remainder: Slot | null =
      slot.duration_min - durationMin >= 1
        ? { start: usedEnd, end: slot.end, duration_min: slot.duration_min - durationMin, energy_weight: slot.energy_weight }
        : null;

    availableSlots = [...availableSlots.slice(0, slotIdx), ...(remainder ? [remainder] : []), ...availableSlots.slice(slotIdx + 1)];
    availableSlots = sortSlots(availableSlots);

    const activity: Activity = {
      subtopic_id: subtopicId,
      resource_id: null,
      action,
      start: slot.start,
      end: usedEnd,
      duration_min: durationMin,
      priority: gapById.get(subtopicId)?.priority ?? null,
      predicted_score: score,
      expected_mastery_after: score,
      provisional: forceProvisional,
    };
    lastScheduledEnd.set(subtopicId, usedEnd);
    return activity;
  }

  // 4a. IMMEDIATE_TEST as its own selected action (thin-evidence checkpoint, §4.2 rule 1).
  for (const gapEntry of gapTable) {
    if (gapEntry.action !== "IMMEDIATE_TEST") continue;
    const activity = placeShortActivity(gapEntry.subtopic_id, "IMMEDIATE_TEST", PLANNER.immediate_test_duration_min, assessmentEarliestStart);
    if (activity) activities.push(activity);
  }

  // 4b. IMMEDIATE_TEST as an automatic same-day checkpoint after fresh LEARN.
  for (const [subtopicId, learnEnd] of lastLearnEnd) {
    const notBefore = learnEnd.getTime() > assessmentEarliestStart.getTime() ? learnEnd : assessmentEarliestStart;
    const activity = placeShortActivity(subtopicId, "IMMEDIATE_TEST", PLANNER.immediate_test_duration_min, notBefore, learnEnd);
    if (activity) activities.push(activity);
  }

  // 4c. recall proposals, sorted so input order never affects the result (§8).
  const sortedRecall = [...input.recallProposals].sort(
    (a, b) => a.due_at.getTime() - b.due_at.getTime() || a.subtopic_id.localeCompare(b.subtopic_id) || a.interval_index - b.interval_index,
  );
  const recalledSubtopics = new Set<string>();
  for (const proposal of sortedRecall) {
    const action: ActionType = proposal.reason === "recall_failure" ? "REVISION" : "ACTIVE_RECALL";
    const notBefore = proposal.due_at.getTime() > assessmentEarliestStart.getTime() ? proposal.due_at : assessmentEarliestStart;
    const activity = placeShortActivity(proposal.subtopic_id, action, proposal.suggested_duration_min, notBefore);
    if (activity) activities.push(activity);
    recalledSubtopics.add(proposal.subtopic_id);
  }

  // 4c'. ACTIVE_RECALL / REVISION selected directly by the gap table (§4) for a subtopic
  // Phase 3 didn't already hand us a recall proposal for. Without this, an action the
  // selector explicitly chose would silently never appear in the plan.
  for (const gapEntry of gapTable) {
    if (gapEntry.action !== "ACTIVE_RECALL" && gapEntry.action !== "REVISION") continue;
    if (recalledSubtopics.has(gapEntry.subtopic_id)) continue;
    const duration = gapEntry.action === "REVISION" ? RECALL.default_revision_duration_min : RECALL.default_recall_duration_min;
    const activity = placeShortActivity(gapEntry.subtopic_id, gapEntry.action, duration, assessmentEarliestStart);
    if (activity) activities.push(activity);
  }

  // 4d. FINAL_TEST once all learn/practice for a subtopic are placed (i.e. selected by the action selector).
  for (const gapEntry of gapTable) {
    if (gapEntry.action !== "FINAL_TEST") continue;
    const finalDuration = PLANNER.final_test_duration_min_range[1];
    const activity = placeShortActivity(gapEntry.subtopic_id, "FINAL_TEST", finalDuration, assessmentEarliestStart);
    if (activity) activities.push(activity);
  }

  // 4e. milestone assessment every 7 days across the three highest-weight subtopics.
  const topWeighted = Object.entries(goal.blueprint)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, PLANNER.milestone_top_n_subtopics)
    .map(([id]) => id);
  if (topWeighted.length > 0) {
    let milestoneIdx = 0;
    for (let day = new Date(simNow); day.getTime() < goal.deadline.getTime(); day = new Date(day.getTime() + PLANNER.milestone_interval_days * 86_400_000)) {
      const notBefore = day.getTime() > assessmentEarliestStart.getTime() ? day : assessmentEarliestStart;
      // Activity is single-subtopic; a milestone nominally covers all of topWeighted, so
      // rotate through them rather than pinning every milestone to the same one.
      const subtopicId = topWeighted[milestoneIdx % topWeighted.length];
      milestoneIdx++;
      const activity = placeShortActivity(subtopicId, "MILESTONE", PLANNER.milestone_duration_min, notBefore);
      if (activity) activities.push(activity);
    }
  }

  // ---- Step 6: projection ----------------------------------------------------
  const scheduledMinutesBySubtopic = new Map<string, number>();
  for (const a of activities) {
    scheduledMinutesBySubtopic.set(a.subtopic_id, (scheduledMinutesBySubtopic.get(a.subtopic_id) ?? 0) + a.duration_min);
  }

  const projectedMasteryAtDeadline: Record<string, number> = {};
  let projectedGoalAttainment = 0;
  for (const [subtopicId, weight] of Object.entries(goal.blueprint)) {
    const belief = beliefById.get(subtopicId);
    const mu = belief?.mu ?? 0;
    const learnRate = belief?.learn_rate ?? 0.1;
    const scheduledHours = (scheduledMinutesBySubtopic.get(subtopicId) ?? 0) / 60;
    const projected = clamp(mu + learnRate * scheduledHours, 0, 1);
    projectedMasteryAtDeadline[subtopicId] = projected;

    const target = goal.target_mastery[subtopicId] ?? 0;
    projectedGoalAttainment += weight * (target > 0 ? Math.min(1, projected / target) : 1);
  }

  const projection: PlanProjection = {
    projected_mastery_at_deadline: projectedMasteryAtDeadline,
    projected_goal_attainment: clamp(projectedGoalAttainment, 0, 1),
    deficit_hours: deficitHours,
    unplaced_hours: unplacedHours,
  };

  // Canonical output order, independent of any input array ordering (§8 determinism).
  activities.sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.subtopic_id.localeCompare(b.subtopic_id) || a.action.localeCompare(b.action),
  );

  return { activities, projection, degraded_tools: [...degradedSignals].sort() };
}
