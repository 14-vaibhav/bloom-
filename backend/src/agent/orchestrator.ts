/**
 * The eleven-phase agent loop (bloom-phase6-brief §6). One call to tick()
 * is one run: OBSERVE -> UPDATE BELIEFS -> EVALUATE TRIGGERS -> ANALYZE ->
 * DECIDE -> RETRIEVE -> PLAN -> VALIDATE -> REPAIR -> COMMIT -> ACT/INFORM.
 *
 * Phases 1-9 write nothing but agent_events and idempotent beliefs (§2).
 * Everything else — plan version, activities, calendar, run status — lands
 * in ONE transaction in phase 10, via commitPlan() -> state.save_plan_version.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentEvents, agentRuns, learningActivities, learningGoals, resourceFeedback, students } from "../db/schema.js";
import { publishAgentEvent } from "../lib/eventBus.js";
import { createSeqCounter, type AgentContext, type AgentPhase } from "../tools/context.js";
import { callTool } from "../tools/dispatcher.js";
import { StateStoreUnavailableError } from "../tools/errors.js";
import type { ToolOutput } from "../tools/schemas.js";

import { buildGapTable } from "../core/gapEngine.js";
import { buildPlan } from "../core/planner.js";
import { negotiate } from "../core/negotiate.js";
import { runValidationLoop } from "../core/repair.js";
import { generateSlots } from "../core/slotter.js";
import type { Activity, ActionType, BusyInterval, DropCandidate, GapEntry, LearningGoal, Plan, Slot, SubtopicBelief, TopicGraph, ValidatorState } from "../core/types.js";
import { PLANNER, RECALL } from "../core/constants.js";

import { getSimNow } from "./simClock.js";
import { collectObservations, type CollectedObservations } from "./observe.js";
import { getAllBeliefs, refreshDecay, updateBelief } from "./beliefs.js";
import { evaluateTriggers, type TriggerDecision, type TriggerInput, type TriggerName } from "./triggers.js";
import {
  buildGapEngineInputs,
  buildLearningGoal,
  buildStudentConstraints,
  buildTopicGraph,
  computeRepeatedWeaknessBySubtopic,
  findPreemptiveRecallSubtopics,
  loadCompletionInfo,
  loadConceptTags,
  loadResourceDurations,
  retrieveResourcesForSubtopic,
} from "./assemble.js";
import { deferActivities, insertActivity, rescheduleActivity, swapResource, type PatchActivity } from "./patchOps.js";
import { commitPlan, type CommitActivity, type PersistableAction } from "./commit.js";
import { computeStatus, computeTrajectory, computeDailySummary } from "./summary.js";
import { runCurator, runDiagnostician, runStrategist, validateNegotiationMessage } from "./llm/specialists.js";

const EPOCH = new Date(0);
const PERSISTABLE_ACTIONS = new Set<ActionType>(["LEARN", "PRACTICE", "IMMEDIATE_TEST", "ACTIVE_RECALL", "REVISION", "FINAL_TEST"]);

/** A test-only crash hook: throwing right after a given phase is marked complete simulates
 * the process dying there (bloom-phase6-brief §10, Scenario F). Never set outside tests. */
export type TickOptions = { crashAtPhase?: number };

export type TickResult = {
  runId: string;
  scope: "NONE" | "PATCH" | "FULL" | "NEGOTIATE";
  outcome: "no_action" | "patched" | "replanned" | "infeasible" | "error";
  reason: string;
  newPlanVersion?: number;
  toolCallCount?: number;
};

type ActivityWithLineage = Activity & { _lineageId?: string };

function toActivity(pa: PatchActivity): ActivityWithLineage {
  return {
    subtopic_id: pa.subtopic_id,
    resource_id: pa.resource_id,
    action: pa.action,
    start: pa.start,
    end: pa.end,
    duration_min: pa.duration_min,
    priority: pa.priority,
    predicted_score: pa.predicted_score ?? 0,
    expected_mastery_after: pa.expected_mastery_after ?? 0,
    provisional: pa.provisional,
    _lineageId: pa.id.startsWith("new:") ? undefined : pa.id,
  };
}

function lineageOf(a: Activity): string | undefined {
  return (a as ActivityWithLineage)._lineageId;
}

async function appendEvent(ctx: AgentContext, phase: AgentPhase, message: string, payload?: unknown): Promise<void> {
  const [row] = await db.insert(agentEvents).values({ runId: ctx.runId, studentId: ctx.studentId, seq: ctx.nextSeq(), phase, eventType: "decision", message, payload: payload as object | undefined }).returning();
  publishAgentEvent(row);
}

/** Reads back this run's own event log for any degraded-mode fallback the dispatcher
 * already logged (RAG/calendar/qbank circuit open) and turns its `signal` into the
 * DegradedSignal the planner needs — buildPlan has no other way to learn a tool was down. */
async function collectDegradedSignals(runId: string): Promise<import("../core/types.js").DegradedSignal[]> {
  const rows = await db.query.agentEvents.findMany({ where: (e, { eq: eqOp }) => eqOp(e.runId, runId) });
  const signals = new Set<string>();
  for (const r of rows) {
    const payload = r.payload as { degraded?: boolean; signal?: string } | null;
    if (payload?.degraded && payload.signal) signals.add(payload.signal);
  }
  return [...signals] as import("../core/types.js").DegradedSignal[];
}

async function computeAttendance14d(studentId: string, planId: string, now: Date): Promise<number | null> {
  const since = new Date(now.getTime() - 14 * 86_400_000);
  const rows = await db.query.learningActivities.findMany({
    where: (a, { and, eq, gte, lt, inArray: inA }) => and(eq(a.studentId, studentId), eq(a.planId, planId), inA(a.status, ["completed", "missed"]), gte(a.scheduledStart, since), lt(a.scheduledStart, now)),
  });
  if (rows.length === 0) return null;
  const completed = rows.filter((r) => r.status === "completed").length;
  return completed / rows.length;
}

async function computeMissedInLast7d(studentId: string, planId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db.query.learningActivities.findMany({
    where: (a, { and, eq, gte }) => and(eq(a.studentId, studentId), eq(a.planId, planId), eq(a.status, "missed"), gte(a.missedAt, since)),
  });
  return rows.length;
}

/** Phase 11 is deliberately computed from persisted state, after the phase-10
 * transaction.  That means the summary can only describe a version that really
 * exists, never an attractive-but-fictional recovery plan. */
async function informWithDailySummary(opts: {
  ctx: AgentContext;
  studentId: string;
  planId: string;
  planVersion: number;
  now: Date;
  goal: LearningGoal;
  beliefs: Map<string, SubtopicBelief>;
  topicGraph: TopicGraph;
  availableHours: number;
}): Promise<void> {
  const activities = await db.query.learningActivities.findMany({
    where: (a, { and, eq }) => and(eq(a.studentId, opts.studentId), eq(a.planId, opts.planId)),
  });
  const attendance14d = await computeAttendance14d(opts.studentId, opts.planId, opts.now);
  const trajectory = await computeTrajectory(
    opts.studentId,
    opts.topicGraph.subtopic_ids,
    new Map([...opts.beliefs].map(([id, b]) => [id, b.learn_rate])),
    opts.now,
  );
  const bySubtopic = new Map<string, { actual_hours: number; predicted_hours: number }>();
  let missedHoursTotal = 0;
  for (const activity of activities) {
    if (activity.status === "missed") missedHoursTotal += activity.durationMin / 60;
    if (activity.status !== "completed") continue;
    const current = bySubtopic.get(activity.subtopicId) ?? { actual_hours: 0, predicted_hours: 0 };
    current.actual_hours += (activity.actualDurationMin ?? activity.durationMin) / 60;
    current.predicted_hours += activity.durationMin / 60;
    bySubtopic.set(activity.subtopicId, current);
  }
  const completed = new Set(
    activities.filter((a) => a.status === "completed" && a.action === "FINAL_TEST").map((a) => a.subtopicId),
  );
  const strongestRemaining = [...opts.beliefs.values()]
    .filter((b) => !completed.has(b.subtopic_id))
    .sort((a, b) => b.mu - a.mu)
    .slice(0, 3)
    .map((b) => b.subtopic_id);
  const requiredHours = computeRequiredHours(opts.beliefs, opts.goal);
  const daysRemaining = Math.max(0, (opts.goal.deadline.getTime() - opts.now.getTime()) / 86_400_000);
  const summary = await computeDailySummary({
    studentId: opts.studentId,
    now: opts.now,
    signals: {
      attendance14d,
      trajectory,
      bufferDays: computeBufferDays(requiredHours, opts.availableHours, daysRemaining, opts.goal.deadline, opts.now),
      requiredHours,
      availableHours: opts.availableHours,
    },
    overruns: [...bySubtopic.entries()].map(([subtopic_id, hours]) => ({ subtopic_id, ...hours })),
    missedHoursTotal,
    completedSubtopics: completed.size,
    totalSubtopics: opts.topicGraph.subtopic_ids.length,
    strongestRemainingSubtopics: strongestRemaining,
    recoveryPlanVersion: opts.planVersion,
  });
  await appendEvent(opts.ctx, "act", `Daily summary: ${summary.message}`);
}

function computeRequiredHours(beliefs: Map<string, SubtopicBelief>, goal: LearningGoal): number {
  let total = 0;
  for (const [id, target] of Object.entries(goal.target_mastery)) {
    const b = beliefs.get(id);
    const gap = Math.max(0, target - (b?.mu ?? 0));
    total += gap / Math.max(b?.learn_rate ?? 0.1, 1e-6);
  }
  return total;
}

function computeBufferDays(requiredHours: number, availableHours: number, daysRemaining: number, deadline: Date, now: Date): number {
  if (daysRemaining <= 0) return (deadline.getTime() - now.getTime()) / 86_400_000;
  const effectiveDailyHours = availableHours / daysRemaining;
  const projectedDays = effectiveDailyHours > 0 ? requiredHours / effectiveDailyHours : Infinity;
  const projectedCompletion = new Date(now.getTime() + projectedDays * 86_400_000);
  return (deadline.getTime() - projectedCompletion.getTime()) / 86_400_000;
}

async function buildRecentlyFiredAt(studentId: string): Promise<Partial<Record<TriggerName, Date>>> {
  const runs = await db.query.agentRuns.findMany({
    where: (r, { and, eq, ne: neq }) => and(eq(r.studentId, studentId), neq(r.status, "running")),
    orderBy: (r, { desc }) => desc(r.startedAt),
    limit: 20,
  });
  const out: Partial<Record<TriggerName, Date>> = {};
  for (const run of runs) {
    const at = run.simAt ?? run.startedAt;
    for (const name of run.trigger.split("+")) {
      const key = name as TriggerName;
      if (!out[key] || out[key]!.getTime() < at.getTime()) out[key] = at;
    }
  }
  return out;
}

/** One tick: observe, decide, (maybe) replan, commit. Safe to call repeatedly and
 * concurrently-in-sequence for the same student — every write inside is idempotent or
 * transactional. See the file header for the phase-by-phase write discipline. */
export async function tick(studentId: string, opts: TickOptions = {}): Promise<TickResult> {
  const now = await getSimNow(studentId);
  const [studentRow] = await db.select().from(students).where(eq(students.id, studentId));
  if (!studentRow) throw new Error(`Student ${studentId} not found`);

  const priorRuns = await db.query.agentRuns.findMany({
    where: (r, { and: andOp, eq: eqOp, ne: neOp }) => andOp(eqOp(r.studentId, studentId), neOp(r.status, "running")),
    orderBy: (r, { desc }) => desc(r.startedAt),
    limit: 1,
  });
  const lastRun = priorRuns[0];
  const sinceSimAt = lastRun?.simAt ?? EPOCH;
  const sinceRealAt = lastRun?.startedAt ?? studentRow.createdAt;
  const recentlyFiredAt = await buildRecentlyFiredAt(studentId);

  const [runRow] = await db.insert(agentRuns).values({ studentId, trigger: "PENDING", scope: "PATCH", simAt: now }).returning();
  const ctx: AgentContext = { runId: runRow.id, studentId, phase: "observe", clock: () => now, nextSeq: createSeqCounter() };

  const markPhase = async (n: number) => {
    await db.update(agentRuns).set({ lastCompletedPhase: n }).where(eq(agentRuns.id, runRow.id));
    if (opts.crashAtPhase === n) throw new Error(`__TEST_CRASH_AT_PHASE_${n}__`);
  };

  const fail = async (errorClass: string, detail: string): Promise<TickResult> => {
    await db.update(agentRuns).set({ status: "failed", outcome: "error", errorClass, errorDetail: detail.slice(0, 2000), endedAt: new Date() }).where(eq(agentRuns.id, runRow.id));
    return { runId: runRow.id, scope: "NONE", outcome: "error", reason: detail };
  };

  try {
    // ===== phase 1: OBSERVE =====
    ctx.phase = "observe";
    const collected = await collectObservations({ studentId, now, sinceSimAt, sinceRealAt });
    const state = await callTool(ctx, "state.get_student_state", { student_id: studentId });
    await markPhase(1);

    if (!state.goal) {
      await db.update(agentRuns).set({ status: "completed", outcome: "no_action", trigger: "NO_GOAL", scope: "NONE", endedAt: new Date() }).where(eq(agentRuns.id, runRow.id));
      return { runId: runRow.id, scope: "NONE", outcome: "no_action", reason: "No active learning goal — nothing to plan." };
    }
    const goal = buildLearningGoal(state.goal);
    const goalId = state.goal.goal_id;

    // ===== phase 2: UPDATE BELIEFS =====
    ctx.phase = "update_beliefs";
    const beliefEvents: string[] = [];
    for (const a of collected.unprocessedAssessments) {
      const outcome = await updateBelief(
        studentId,
        { source_id: a.assessment_id, source: "assessment", subtopic_id: a.subtopic_id, n: a.question_count, difficulty: a.avg_difficulty, score: a.score, predicted_score: a.predicted_score },
        now,
      );
      if (outcome.applied) {
        beliefEvents.push(
          `${a.subtopic_id}: mu ${outcome.mu_before.toFixed(2)}→${outcome.mu_after.toFixed(2)}, learn_rate ${outcome.learn_rate_before.toFixed(2)}→${outcome.learn_rate_after.toFixed(2)}.`,
        );

        // Scenario C's "that resource blacklisted" — a significant NEGATIVE surprise on a
        // subtopic whose most recent LEARN used a resource is real evidence the resource
        // under-delivered, not just that the student struggled.
        if (outcome.significant && a.prediction_error < 0) {
          const lastLearn = await db.query.learningActivities.findFirst({
            where: (act, { and: andOp, eq: eqOp }) => andOp(eqOp(act.studentId, studentId), eqOp(act.subtopicId, a.subtopic_id), eqOp(act.action, "LEARN")),
            orderBy: (act, { desc }) => desc(act.scheduledStart),
          });
          if (lastLearn?.resourceId) {
            await db.insert(resourceFeedback).values({ studentId, resourceId: lastLearn.resourceId, rating: "unhelpful", observedMasteryGain: String(outcome.mu_after - outcome.mu_before) });
          }
        }
      }
    }
    if (beliefEvents.length > 0) await appendEvent(ctx, "update_beliefs", beliefEvents.join(" "));
    await markPhase(2);

    // ===== phase 3: EVALUATE TRIGGERS =====
    ctx.phase = "triggers";
    const hasActivePlan = state.plan !== null;
    const topicGraph = await buildTopicGraph(state.goal.subject_id);
    let beliefsMap = await getAllBeliefs(studentId, topicGraph.subtopic_ids);
    for (const id of topicGraph.subtopic_ids) await refreshDecay(studentId, id, now);
    beliefsMap = await getAllBeliefs(studentId, topicGraph.subtopic_ids);

    const constraintsRow = state.constraints;
    const constraints = constraintsRow ? buildStudentConstraints(constraintsRow) : null;

    let bufferDays: number | null = null;
    let requiredHours = 0;
    let availableHours = 0;
    let slots: Slot[] = [];
    let externalEvents: BusyInterval[] = [];
    if (hasActivePlan && constraints) {
      const [existingEvents, availableSlotsOut] = await Promise.all([
        callTool(ctx, "calendar.get_existing_events", { student_id: studentId, from: now.toISOString(), to: goal.deadline.toISOString() }),
        callTool(ctx, "calendar.get_available_slots", { student_id: studentId, from: now.toISOString(), to: goal.deadline.toISOString(), min_slot_min: constraints.min_session_min }),
      ]);
      externalEvents = existingEvents.filter((e) => e.source === "external").map((e) => ({ start: new Date(e.starts_at), end: new Date(e.ends_at) }));
      slots = availableSlotsOut.map((s) => ({ start: new Date(s.start), end: new Date(s.end), duration_min: s.duration_min, energy_weight: s.energy_weight }));
      requiredHours = computeRequiredHours(beliefsMap, goal);
      availableHours = slots.reduce((sum, s) => sum + s.duration_min, 0) / 60;
      const daysRemaining = Math.max(0, (goal.deadline.getTime() - now.getTime()) / 86_400_000);
      bufferDays = computeBufferDays(requiredHours, availableHours, daysRemaining, goal.deadline, now);
    }

    const attendance14d = hasActivePlan ? await computeAttendance14d(studentId, state.plan!.plan_id, now) : null;
    const missedInLast7d = hasActivePlan ? await computeMissedInLast7d(studentId, state.plan!.plan_id, now) : 0;

    const significantPredictionErrors = collected.unprocessedAssessments.filter((a) => a.significant).map((a) => ({ subtopic_id: a.subtopic_id, prediction_error: a.prediction_error }));
    const lowScoreSubtopics = collected.unprocessedAssessments
      .filter((a) => a.score < 0.5 && (goal.blueprint[a.subtopic_id] ?? 0) > 0.10)
      .map((a) => ({ subtopic_id: a.subtopic_id, score: a.score }));
    const recallFailures = collected.unprocessedAssessments
      .filter((a) => a.purpose === "active_recall" && a.score < RECALL.ok_threshold)
      .map((a) => ({ subtopic_id: a.subtopic_id, recall_score: a.score }));
    const preemptiveRecallSubtopics = hasActivePlan ? findPreemptiveRecallSubtopics(beliefsMap, goal, now) : [];

    const calendarConflicts = collected.observations.filter((o) => o.type === "CALENDAR_EVENT_ADDED").map((o) => o.payload as { activity_id: string; subtopic_id: string });
    const resourceFailures = collected.observations.filter((o) => o.type === "RESOURCE_FEEDBACK").map((o) => o.payload as { resource_id: string });
    const recoveredTools = collected.observations.filter((o) => o.type === "TOOL_RECOVERED").map((o) => (o.payload as { tool: string }).tool);
    const availabilityObs = collected.observations.find((o) => o.type === "AVAILABILITY_CHANGED");
    // POST /api/students/:id/deadline (bloom-phase8-brief §A2) never updates a goal row in
    // place — it closes the old one and inserts a new active row with the new deadline, the
    // same effective-dated pattern student_constraints already uses. A goal younger than the
    // last completed run, on a student who already had a plan, is a moved deadline — not the
    // very first goal (that path has hasActivePlan === false and is handled as INITIAL_GOAL).
    const [goalRow] = await db.select({ createdAt: learningGoals.createdAt }).from(learningGoals).where(eq(learningGoals.id, goalId));
    const deadlineMoved = hasActivePlan && goalRow !== undefined && goalRow.createdAt.getTime() > sinceSimAt.getTime();

    const triggerInput: TriggerInput = {
      now,
      hasActivePlan,
      observations: collected.observations,
      missedInLast7d,
      attendance14d,
      bufferDays,
      significantPredictionErrors,
      lowScoreSubtopics,
      recallFailures,
      preemptiveRecallSubtopics,
      calendarConflicts,
      resourceFailures,
      recoveredTools,
      availabilityDeltaRatio: availabilityObs ? (availabilityObs.payload as { delta_ratio: number }).delta_ratio : null,
      deadlineMoved,
      recentlyFiredAt,
    };
    const decision = evaluateTriggers(triggerInput);
    await markPhase(3);

    if (decision.scope === "NONE") {
      await appendEvent(ctx, "triggers", decision.reason);
      await db.update(agentRuns).set({ status: "completed", outcome: "no_action", trigger: "NONE", scope: "NONE", endedAt: new Date() }).where(eq(agentRuns.id, runRow.id));
      return { runId: runRow.id, scope: "NONE", outcome: "no_action", reason: decision.reason };
    }

    const triggerName = decision.triggers.map((t) => t.name).join("+");
    await db.update(agentRuns).set({ trigger: triggerName, scope: decision.scope }).where(eq(agentRuns.id, runRow.id));
    await appendEvent(ctx, "triggers", decision.reason);

    if (decision.scope === "FULL" || decision.scope === "NEGOTIATE" || !hasActivePlan) {
      return await runFull(ctx, runRow.id, studentId, goalId, goal, topicGraph, beliefsMap, decision, triggerName, markPhase, fail, now);
    }

    return await runPatch(ctx, runRow.id, studentId, goalId, goal, topicGraph, beliefsMap, state, decision, triggerName, slots, constraints!, externalEvents, collected, markPhase, fail, now);
  } catch (err) {
    if (err instanceof StateStoreUnavailableError) {
      return fail("StateStoreUnavailableError", err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("__TEST_CRASH_AT_PHASE_")) throw err;
    return fail(err instanceof Error ? err.name : "UnknownError", message);
  }
}

// ────────────────────────────────────────────────────────────────
// FULL / NEGOTIATE path
// ────────────────────────────────────────────────────────────────

async function runFull(
  ctx: AgentContext,
  runId: string,
  studentId: string,
  goalId: string,
  goal: LearningGoal,
  topicGraph: TopicGraph,
  beliefsMap: Map<string, SubtopicBelief>,
  decision: TriggerDecision,
  triggerName: string,
  markPhase: (n: number) => Promise<void>,
  fail: (c: string, d: string) => Promise<TickResult>,
  now: Date,
): Promise<TickResult> {
  // ===== phase 4: ANALYZE =====
  ctx.phase = "analyze";
  const stateRow = await callTool(ctx, "state.get_student_state", { student_id: studentId });
  const constraintsRow = stateRow.constraints;
  if (!constraintsRow) return fail("PermanentError", "No constraints on file for this student.");
  const constraints = buildStudentConstraints(constraintsRow);

  const completion = await loadCompletionInfo(studentId, stateRow.plan?.plan_id ?? null, stateRow.plan?.current_version ?? null, topicGraph.subtopic_ids);
  const repeatedWeakness = await computeRepeatedWeaknessBySubtopic(studentId, topicGraph.subtopic_ids, goal.blueprint);
  const gapInputs = buildGapEngineInputs(beliefsMap, goal, topicGraph, completion, repeatedWeakness, now);
  let gapTable: GapEntry[] = buildGapTable(gapInputs);
  const diagnosisTarget = [...gapTable].filter((g) => g.action === "LEARN" || g.action === "PRACTICE").sort((a, b) => b.priority - a.priority)[0];
  let diagnosis: Awaited<ReturnType<typeof runDiagnostician>> | null = null;
  if (diagnosisTarget) {
    const conceptTags = await loadConceptTags(diagnosisTarget.subtopic_id);
    if (conceptTags.length > 0) {
      const belief = beliefsMap.get(diagnosisTarget.subtopic_id) ?? fallbackBelief(diagnosisTarget.subtopic_id);
      diagnosis = await runDiagnostician({
        ctx, subtopicId: diagnosisTarget.subtopic_id, concepts: conceptTags, fallbackConcept: conceptTags[0],
        input: { mu: belief.mu, confidence: belief.confidence, format_efficacy: belief.format_efficacy },
      });
      await appendEvent(ctx, "analyze", `Diagnostician (${diagnosis.source}): ${diagnosis.value.root_cause_concept}. ${diagnosis.value.implication}`);
    }
  }
  await markPhase(4);

  // ===== phase 5: DECIDE (deterministic baseline — action already attached per-subtopic by buildGapTable) =====
  ctx.phase = "decide";

  // ===== phase 6: RETRIEVE =====
  ctx.phase = "retrieve";
  const [existingEvents, availableSlotsOut] = await Promise.all([
    callTool(ctx, "calendar.get_existing_events", { student_id: studentId, from: now.toISOString(), to: goal.deadline.toISOString() }),
    callTool(ctx, "calendar.get_available_slots", { student_id: studentId, from: now.toISOString(), to: goal.deadline.toISOString(), min_slot_min: constraints.min_session_min }),
  ]);
  const externalEvents: BusyInterval[] = existingEvents.filter((e) => e.source === "external").map((e) => ({ start: new Date(e.starts_at), end: new Date(e.ends_at) }));
  const slots: Slot[] = availableSlotsOut.map((s) => ({ start: new Date(s.start), end: new Date(s.end), duration_min: s.duration_min, energy_weight: s.energy_weight }));
  const availableHoursForSummary = slots.reduce((sum, s) => sum + s.duration_min, 0) / 60;

  // Calendar availability is deterministic; the Strategist now receives that
  // fixed budget, then its bounded action choice determines which RAG calls
  // below are skipped.
  ctx.phase = "decide";
  const unmetPrerequisites = new Set(
    topicGraph.prerequisites
      .filter((edge) => (beliefsMap.get(edge.prereq_id)?.mu ?? 0) < (goal.target_mastery[edge.prereq_id] ?? 0.75))
      .map((edge) => edge.subtopic_id),
  );
  const baselineActions = new Map(gapTable.map((gap) => [gap.subtopic_id, gap.action]));
  const strategy = await runStrategist({
    ctx,
    gaps: gapTable,
    availableHours: availableHoursForSummary,
    requiredHours: computeRequiredHours(beliefsMap, goal),
    unmetPrerequisites,
    deadline: goal.deadline.toISOString(),
    simNow: now.toISOString(),
  });
  gapTable = gapTable.map((gap) => ({ ...gap, action: strategy.actions.get(gap.subtopic_id) ?? gap.action }));
  const overrideCount = gapTable.filter((gap) => gap.action !== baselineActions.get(gap.subtopic_id)).length;
  const capNote = strategy.cappedOverrides > 0 ? ` (${strategy.cappedOverrides} additional override(s) discarded by the 3-override cap)` : "";
  await appendEvent(ctx, "decide", `Strategist (${strategy.source}): ${overrideCount} action override(s)${capNote}. ${strategy.strategyNote}`);
  await markPhase(5);
  ctx.phase = "retrieve";

  const resourceCandidatesTyped = new Map<string, Awaited<ReturnType<typeof retrieveResourcesForSubtopic>>>();
  for (const entry of gapTable) {
    if (entry.action !== "LEARN" && entry.action !== "PRACTICE") {
      await appendEvent(ctx, "retrieve", `${entry.subtopic_id} → ${entry.action}; resource retrieval skipped.`);
      continue;
    }
    const belief = beliefsMap.get(entry.subtopic_id);
    const targetDifficulty = Math.min(5, Math.max(1, Math.round((belief?.mu ?? 0.3) * 5) + 1));
    const scored = await retrieveResourcesForSubtopic(ctx, studentId, entry.subtopic_id, belief ?? fallbackBelief(entry.subtopic_id), targetDifficulty, constraints.max_session_min);
    if (diagnosis && entry.subtopic_id === diagnosisTarget?.subtopic_id && scored.length > 0) {
      const curated = await runCurator({
        ctx, candidates: scored,
        input: { subtopic_id: entry.subtopic_id, mu: belief?.mu ?? 0, slot_minutes: constraints.max_session_min, focus_concept: diagnosis.value.recommended_resource_profile.focus_concept },
      });
      if (curated) {
        const chosen = scored.find((candidate) => candidate.resource_id === curated.value.chosen_resource_id);
        resourceCandidatesTyped.set(entry.subtopic_id, chosen ? [chosen, ...scored.filter((candidate) => candidate !== chosen)] : scored);
        await appendEvent(ctx, "retrieve", `Curator (${curated.source}): chose ${curated.value.chosen_resource_id}. ${curated.value.justification}`);
        continue;
      }
    }
    resourceCandidatesTyped.set(entry.subtopic_id, scored);
  }

  // ===== phase 6.5: recall proposals =====
  const recallProposals = buildRecallProposalsForFull(gapTable, beliefsMap, goal, now);

  // ===== phase 7: PLAN =====
  ctx.phase = "plan";
  const degradedSignals = await collectDegradedSignals(ctx.runId);
  const candidatePlan: Plan = buildPlan({
    goal,
    beliefs: [...beliefsMap.values()],
    gapTable,
    slots,
    resourceCandidates: resourceCandidatesTyped,
    recallProposals,
    topicGraph,
    simNow: now,
    degradedSignals,
  });
  await markPhase(7);

  // ===== phase 8-9: VALIDATE / REPAIR =====
  ctx.phase = "validate";
  const resourceIds = candidatePlan.activities.map((a) => a.resource_id).filter((id): id is string => id !== null);
  const resourceDurations = await loadResourceDurations(resourceIds);
  const completedActiveRecallCounts: Record<string, number> = {};
  for (const [id, info] of completion) completedActiveRecallCounts[id] = info.active_recall_completed_count;

  const validatorState: ValidatorState = { beliefs: [...beliefsMap.values()], topicGraph, goal, gapTable, externalEvents, resourceDurations, completedActiveRecallCounts };
  await markPhase(8);
  ctx.phase = "repair";
  const repairResult = runValidationLoop(candidatePlan, validatorState, constraints);
  await markPhase(9);
  await appendEvent(ctx, "validate", `Validation: ${repairResult.finalReport.hard_failures} hard failures, route ${repairResult.finalReport.route}, ${repairResult.rounds} repair round(s).`, repairResult.finalReport);
  for (const entry of repairResult.log) await appendEvent(ctx, "repair", entry.detail);

  const finalScope = repairResult.route === "negotiate" ? "NEGOTIATE" : "FULL";

  if (repairResult.route === "negotiate") {
    const dropCandidates: DropCandidate[] = Object.entries(goal.blueprint)
      .filter(([id]) => !goal.must_have_subtopics.includes(id))
      .map(([id, weight]) => ({ subtopic_id: id, weight, hours_needed: Math.max(0, (goal.target_mastery[id] ?? 0) - (beliefsMap.get(id)?.mu ?? 0)) / Math.max(beliefsMap.get(id)?.learn_rate ?? 0.1, 1e-6) }))
      .sort((a, b) => a.weight - b.weight);

    const requiredHours = computeRequiredHours(beliefsMap, goal);
    const availableHours = slots.reduce((sum, s) => sum + s.duration_min, 0) / 60;
    const daysRemaining = Math.max(1, (goal.deadline.getTime() - now.getTime()) / 86_400_000);

    if (requiredHours <= availableHours) {
      // L5 alone routed here (a must-have subtopic under target) even though time isn't the
      // binding constraint — negotiate() requires an actual deficit, so fall through to a
      // best-effort commit of the repaired plan instead of calling it under a false premise.
      return await commitAndFinish(ctx, runId, studentId, goalId, "FULL", triggerName, decision.reason, repairResult.plan, gapTable, repairResult.finalReport, repairResult.rounds, markPhase, fail, undefined, { goal, beliefsMap, topicGraph, availableHours });
    }

    const negotiation = negotiate({ required_hours: requiredHours, available_hours: availableHours, days_remaining: daysRemaining, must_have_subtopics: goal.must_have_subtopics, drop_candidates: dropCandidates, plan: repairResult.plan });
    // The Strategist's prose is only trusted if every numeral in it already appears
    // among the deterministic options — an invented figure is worse than none.
    const negotiationMessage = validateNegotiationMessage(strategy.negotiationMessage, negotiation.options);
    const negotiationSuffix = negotiationMessage ? ` Strategist: ${negotiationMessage}` : "";
    await appendEvent(ctx, "repair", `Infeasible: ${negotiation.deficit_hours}h deficit. Recommended option ${negotiation.recommended} — ${negotiation.recommendation_reason}${negotiationSuffix}`, negotiation);

    return await commitAndFinish(ctx, runId, studentId, goalId, "NEGOTIATE", triggerName, decision.reason, negotiation.best_partial_plan, gapTable, repairResult.finalReport, repairResult.rounds, markPhase, fail, negotiation, { goal, beliefsMap, topicGraph, availableHours });
  }

  return await commitAndFinish(ctx, runId, studentId, goalId, finalScope, triggerName, decision.reason, repairResult.plan, gapTable, repairResult.finalReport, repairResult.rounds, markPhase, fail, undefined, { goal, beliefsMap, topicGraph, availableHours: availableHoursForSummary });
}

function fallbackBelief(subtopicId: string): SubtopicBelief {
  return {
    subtopic_id: subtopicId, mu: 0, confidence: 0, learn_rate: 0.1, evidence_count: 0, assessment_count: 0,
    last_observed_at: null, mu_at_last_observation: 0, hours_since_last_observation: 0, prediction_error_ema: 0,
    format_efficacy: { video: 0.1, article: 0.1, practice: 0.1, doc: 0.1, course: 0.1 }, retention_estimate: 0, strength_days: 3,
  };
}

function buildRecallProposalsForFull(gapTable: GapEntry[], beliefsMap: Map<string, SubtopicBelief>, goal: LearningGoal, now: Date) {
  const proposals = [];
  for (const entry of gapTable) {
    const belief = beliefsMap.get(entry.subtopic_id);
    if (!belief) continue;
    const weight = goal.blueprint[entry.subtopic_id] ?? 0;
    const target = goal.target_mastery[entry.subtopic_id] ?? 0.75;
    if (belief.mu >= target && weight > RECALL.min_blueprint_weight_for_recall) {
      const daysSince = belief.last_observed_at ? (now.getTime() - belief.last_observed_at.getTime()) / 86_400_000 : 999;
      if (daysSince >= RECALL.base_intervals_days[0]) {
        proposals.push({ subtopic_id: entry.subtopic_id, due_at: now, urgency: RECALL.urgency_scheduled, reason: "scheduled_interval" as const, suggested_duration_min: RECALL.default_recall_duration_min, interval_index: 0 });
      }
    }
  }
  return proposals;
}

async function commitAndFinish(
  ctx: AgentContext,
  runId: string,
  studentId: string,
  goalId: string,
  scope: "FULL" | "NEGOTIATE",
  trigger: string,
  reason: string,
  plan: Plan,
  gapTable: GapEntry[],
  validationReport: unknown,
  repairRounds: number,
  markPhase: (n: number) => Promise<void>,
  fail: (c: string, d: string) => Promise<TickResult>,
  negotiation?: unknown,
  summaryContext?: { goal: LearningGoal; beliefsMap: Map<string, SubtopicBelief>; topicGraph: TopicGraph; availableHours: number },
): Promise<TickResult> {
  ctx.phase = "commit";
  const activities: CommitActivity[] = plan.activities.filter((a) => PERSISTABLE_ACTIONS.has(a.action)).map((a) => ({
    subtopic_id: a.subtopic_id,
    resource_id: a.resource_id,
    action: a.action as PersistableAction,
    start: a.start,
    end: a.end,
    duration_min: a.duration_min,
    priority: a.priority,
    predicted_score: a.predicted_score,
    expected_mastery_after: a.expected_mastery_after,
    provisional: a.provisional,
  }));

  let outcome: CommitOutcomeName;
  try {
    const result = await commitPlan(ctx, {
      studentId, goalId, trigger, scope, reason, activities,
      gapSnapshot: gapTable.map((g) => ({ subtopic_id: g.subtopic_id, priority: g.priority, action: g.action })),
      projection: { ...plan.projection, negotiation: negotiation ?? null },
      validationReport, repairRounds, runId,
    });
    await markPhase(10);
    ctx.phase = "act";
    outcome = scope === "NEGOTIATE" ? "infeasible" : "replanned";
    await appendEvent(ctx, "act", `Committed plan v${result.version}: ${result.diff.added.length} added, ${result.diff.removed.length} removed, ${result.diff.moved.length} moved, ${result.diff.modified.length} modified, ${result.diff.unchanged_count} unchanged.`);
    if (summaryContext) {
      await informWithDailySummary({
        ctx, studentId, planId: result.plan_id, planVersion: result.version, now: ctx.clock(),
        goal: summaryContext.goal, beliefs: summaryContext.beliefsMap, topicGraph: summaryContext.topicGraph,
        availableHours: summaryContext.availableHours,
      });
    }
    await markPhase(11);
    await db.update(agentRuns).set({ outcome, status: "completed" }).where(eq(agentRuns.id, runId));
    return { runId, scope, outcome, reason, newPlanVersion: result.version };
  } catch (err) {
    if (err instanceof StateStoreUnavailableError) throw err;
    return fail(err instanceof Error ? err.name : "UnknownError", err instanceof Error ? err.message : String(err));
  }
}

type CommitOutcomeName = "replanned" | "infeasible";

// ────────────────────────────────────────────────────────────────
// PATCH path
// ────────────────────────────────────────────────────────────────

async function runPatch(
  ctx: AgentContext,
  runId: string,
  studentId: string,
  goalId: string,
  goal: LearningGoal,
  topicGraph: TopicGraph,
  beliefsMap: Map<string, SubtopicBelief>,
  state: ToolOutput<"state.get_student_state">,
  decision: TriggerDecision,
  triggerName: string,
  slots: Slot[],
  constraints: ReturnType<typeof buildStudentConstraints>,
  externalEvents: BusyInterval[],
  collected: CollectedObservations,
  markPhase: (n: number) => Promise<void>,
  fail: (c: string, d: string) => Promise<TickResult>,
  now: Date,
): Promise<TickResult> {
  // ===== phase 4: ANALYZE (lightweight — no full gap table needed for PATCH's bounded ops,
  // but the validator still needs one for L1) =====
  ctx.phase = "analyze";
  const completion = await loadCompletionInfo(studentId, state.plan!.plan_id, state.plan!.current_version, topicGraph.subtopic_ids);
  const repeatedWeakness = await computeRepeatedWeaknessBySubtopic(studentId, topicGraph.subtopic_ids, goal.blueprint);
  const gapInputs = buildGapEngineInputs(beliefsMap, goal, topicGraph, completion, repeatedWeakness, now);
  const gapTable = buildGapTable(gapInputs);
  await markPhase(4);

  ctx.phase = "decide";
  await markPhase(5);

  // ===== phase 6: RETRIEVE — only when a patch op actually needs a resource =====
  ctx.phase = "retrieve";
  const needsResource = decision.triggers.some((t) => t.name === "RESOURCE_FAILURE" || t.name === "TOOL_RECOVERED");
  let toolCallsThisPhase = 0;
  if (!needsResource) {
    await appendEvent(ctx, "retrieve", "No resource-affecting trigger fired; RAG skipped.");
  }

  // ===== phase 7: PLAN — apply the bounded patch op(s) =====
  ctx.phase = "plan";
  const existingActivities = state.plan!.upcoming_activities;
  let working: PatchActivity[] = existingActivities.map((a) => ({
    id: a.activity_id, subtopic_id: a.subtopic_id, resource_id: a.resource_id, action: a.action, start: new Date(a.scheduled_start),
    end: new Date(a.scheduled_end), duration_min: a.duration_min, priority: a.priority, predicted_score: a.predicted_score, expected_mastery_after: a.expected_mastery_after, provisional: a.provisional,
  }));

  const touchedSummaries: string[] = [];

  for (const missed of collected.missedThisTick) {
    const result = rescheduleActivity(working, slots, { activityId: missed.id, notBefore: now });
    working = result.activities;
    if (result.touched.length > 0) touchedSummaries.push(`Rescheduled ${missed.subtopicId} (${missed.action}).`);
  }
  for (const conflict of collected.observations.filter((o) => o.type === "CALENDAR_EVENT_ADDED")) {
    const p = conflict.payload as { activity_id: string; subtopic_id: string };
    const result = rescheduleActivity(working, slots, { activityId: p.activity_id, notBefore: now });
    working = result.activities;
    if (result.touched.length > 0) touchedSummaries.push(`Rescheduled ${p.subtopic_id} around a new calendar conflict.`);
  }

  for (const entry of gapTable) {
    if (entry.action !== "ACTIVE_RECALL" && entry.action !== "REVISION") continue;
    const belief = beliefsMap.get(entry.subtopic_id);
    const duration = entry.action === "REVISION" ? RECALL.default_revision_duration_min : RECALL.default_recall_duration_min;
    const result = insertActivity(working, slots, {
      subtopic_id: entry.subtopic_id, action: entry.action, duration_min: duration, notBefore: now,
      predicted_score: belief?.mu ?? 0, expected_mastery_after: belief?.mu ?? 0,
    });
    if (result.inserted > 0) {
      working = result.activities;
      touchedSummaries.push(`Inserted ${entry.action} for ${entry.subtopic_id}.`);
    }
  }

  // CONFUSION_SIGNAL (v4 §N7.1): the student kept asking the tutor about a subtopic they are unsure of → schedule a test.
  for (const op of decision.patch_operations ?? []) {
    if (op.op !== "INSERT_ACTIVITY" || op.params.action !== "IMMEDIATE_TEST") continue;
    const subtopicId = op.params.subtopic_id as string;
    if (working.some((a) => a.subtopic_id === subtopicId && a.action === "IMMEDIATE_TEST" && a.start.getTime() >= now.getTime())) continue;
    const belief = beliefsMap.get(subtopicId);
    const result = insertActivity(working, slots, {
      subtopic_id: subtopicId, action: "IMMEDIATE_TEST", duration_min: Math.max(PLANNER.immediate_test_duration_min, constraints.min_session_min), notBefore: now,
      predicted_score: belief?.mu ?? 0, expected_mastery_after: belief?.mu ?? 0,
    });
    if (result.inserted > 0) {
      working = result.activities;
      touchedSummaries.push(`Inserted IMMEDIATE_TEST for ${subtopicId} after repeated tutor questions.`);
    }
  }

  for (const rf of collected.observations.filter((o) => o.type === "RESOURCE_FEEDBACK")) {
    const p = rf.payload as { resource_id: string };
    const affected = working.find((a) => a.resource_id === p.resource_id && (a.action === "LEARN" || a.action === "PRACTICE"));
    if (!affected) continue;
    const belief = beliefsMap.get(affected.subtopic_id) ?? fallbackBelief(affected.subtopic_id);
    const ranked = await retrieveResourcesForSubtopic(ctx, studentId, affected.subtopic_id, belief, 3, affected.duration_min);
    toolCallsThisPhase++;
    const replacement = ranked.find((r) => r.resource_id !== p.resource_id) ?? null;
    const result = swapResource(working, { activityId: affected.id, newResourceId: replacement?.resource_id ?? null });
    working = result.activities;
    if (result.touched.length > 0) touchedSummaries.push(`Swapped resource for ${affected.subtopic_id} away from ${p.resource_id}.`);
  }

  for (const toolName of collected.observations.filter((o) => o.type === "TOOL_RECOVERED").map((o) => (o.payload as { tool: string }).tool)) {
    if (toolName !== "rag") continue;
    const provisional = working.filter((a) => a.provisional);
    for (const p of provisional) {
      const belief = beliefsMap.get(p.subtopic_id) ?? fallbackBelief(p.subtopic_id);
      const ranked = await retrieveResourcesForSubtopic(ctx, studentId, p.subtopic_id, belief, 3, p.duration_min);
      toolCallsThisPhase++;
      const best = ranked[0] ?? null;
      const result = swapResource(working, { activityId: p.id, newResourceId: best?.resource_id ?? p.resource_id, clearProvisional: true });
      working = result.activities;
      if (result.touched.length > 0) touchedSummaries.push(`Re-planned provisional activity for ${p.subtopic_id} now that RAG has recovered.`);
    }
  }

  void deferActivities; // available for a future DEADLINE_RISK-under-PATCH-scope refinement; not wired to a trigger yet
  await markPhase(7);
  if (touchedSummaries.length > 0) await appendEvent(ctx, "plan", touchedSummaries.join(" "));

  // ===== phase 8-9: VALIDATE / REPAIR — same loop a FULL replan uses =====
  ctx.phase = "validate";
  const candidatePlan: Plan = { activities: working.map(toActivity), projection: { projected_mastery_at_deadline: {}, projected_goal_attainment: 0, deficit_hours: 0, unplaced_hours: {} }, degraded_tools: [] };
  const resourceIds = working.map((a) => a.resource_id).filter((id): id is string => id !== null);
  const resourceDurations = await loadResourceDurations(resourceIds);
  const completedActiveRecallCounts: Record<string, number> = {};
  for (const [id, info] of completion) completedActiveRecallCounts[id] = info.active_recall_completed_count;

  const validatorState: ValidatorState = { beliefs: [...beliefsMap.values()], topicGraph, goal, gapTable, externalEvents, resourceDurations, completedActiveRecallCounts };
  await markPhase(8);
  ctx.phase = "repair";
  const repairResult = runValidationLoop(candidatePlan, validatorState, constraints);
  await markPhase(9);
  await appendEvent(ctx, "validate", `Validation: ${repairResult.finalReport.hard_failures} hard failures, route ${repairResult.finalReport.route}, ${repairResult.rounds} repair round(s).`, repairResult.finalReport);
  for (const entry of repairResult.log) await appendEvent(ctx, "repair", entry.detail);

  if (repairResult.route === "negotiate") {
    // A PATCH that can't be repaired escalates to a full replan rather than forcing an
    // under-informed negotiation off a partial activity set (§11: "NEGOTIATE supersedes all").
    return await runFull(ctx, runId, studentId, goalId, goal, topicGraph, beliefsMap, decision, triggerName, markPhase, fail, now);
  }

  // ===== phase 10: COMMIT =====
  ctx.phase = "commit";
  const finalActivities: CommitActivity[] = repairResult.plan.activities.filter((a) => PERSISTABLE_ACTIONS.has(a.action)).map((a) => ({
    carried_from_activity_id: lineageOf(a),
    subtopic_id: a.subtopic_id,
    resource_id: a.resource_id,
    action: a.action as PersistableAction,
    start: a.start,
    end: a.end,
    duration_min: a.duration_min,
    priority: a.priority,
    predicted_score: a.predicted_score,
    expected_mastery_after: a.expected_mastery_after,
    provisional: a.provisional,
  }));

  try {
    const result = await commitPlan(ctx, {
      studentId, goalId, trigger: triggerName, scope: "PATCH", reason: decision.reason, activities: finalActivities,
      gapSnapshot: gapTable.map((g) => ({ subtopic_id: g.subtopic_id, priority: g.priority, action: g.action })),
      validationReport: repairResult.finalReport, repairRounds: repairResult.rounds, runId,
    });
    await markPhase(10);
    ctx.phase = "act";
    await appendEvent(ctx, "act", `PATCH committed as v${result.version}: ${result.diff.moved.length} moved, ${result.diff.modified.length} modified, ${result.diff.added.length} added, ${result.diff.unchanged_count} unchanged. ${toolCallsThisPhase} extra tool call(s) in retrieve.`);
    await informWithDailySummary({
      ctx, studentId, planId: result.plan_id, planVersion: result.version, now,
      goal, beliefs: beliefsMap, topicGraph, availableHours: slots.reduce((sum, slot) => sum + slot.duration_min, 0) / 60,
    });
    await markPhase(11);
    await db.update(agentRuns).set({ outcome: "patched", status: "completed" }).where(eq(agentRuns.id, runId));
    return { runId, scope: "PATCH", outcome: "patched", reason: decision.reason, newPlanVersion: result.version };
  } catch (err) {
    if (err instanceof StateStoreUnavailableError) throw err;
    return fail(err instanceof Error ? err.name : "UnknownError", err instanceof Error ? err.message : String(err));
  }
}

export { computeStatus, computeTrajectory, computeDailySummary };
