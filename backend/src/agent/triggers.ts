/**
 * EVALUATE TRIGGERS (phase 3, bloom-phase6-brief §5). Pure: every input is a
 * plain value the orchestrator has already computed or queried — nothing
 * here touches the DB, the clock, or a tool. That's what makes triggers.test.ts
 * able to drive every branch without a database.
 *
 * FEASIBILITY_BREACH is deliberately absent — it can only be known after
 * PLAN/VALIDATE/REPAIR (phases 7-9) have already run for a tick whose scope
 * this function already decided, so the orchestrator applies it as its own
 * post-hoc escalation to NEGOTIATE, not as an input here.
 */

import type { Observation } from "./observe.js";

export type TriggerName =
  | "INITIAL_GOAL"
  | "HIGH_PREDICTION_ERROR"
  | "AVAILABILITY_CHANGE"
  | "MISSED_STREAK"
  | "DEADLINE_RISK"
  | "LOW_SCORE"
  | "ACTIVE_RECALL_FAILURE"
  | "MISSED_SESSION"
  | "CALENDAR_CONFLICT"
  | "RESOURCE_FAILURE"
  | "TOOL_RECOVERED"
  | "CONFUSION_SIGNAL";

export type Scope = "NONE" | "PATCH" | "FULL" | "NEGOTIATE";

export type FiredTrigger = {
  name: TriggerName;
  severity: number;
  scope: Exclude<Scope, "NONE">;
  detail: string;
  /** CONFUSION_SIGNAL: the subtopics the student kept asking the tutor about. */
  subtopic_ids?: string[];
};

export type PatchOpName = "RESCHEDULE_ACTIVITY" | "INSERT_ACTIVITY" | "SWAP_RESOURCE" | "DEFER_ACTIVITIES";

export type PatchOp = { op: PatchOpName; params: Record<string, unknown> };

export type TriggerDecision = {
  scope: Scope;
  triggers: FiredTrigger[];
  reason: string;
  patch_operations?: PatchOp[];
  debounced: TriggerName[];
};

const SEVERITY: Record<TriggerName, number> = {
  INITIAL_GOAL: 100,
  HIGH_PREDICTION_ERROR: 80,
  AVAILABILITY_CHANGE: 85,
  MISSED_STREAK: 75,
  DEADLINE_RISK: 70,
  LOW_SCORE: 55,
  ACTIVE_RECALL_FAILURE: 45,
  MISSED_SESSION: 40,
  CALENDAR_CONFLICT: 40,
  RESOURCE_FAILURE: 30,
  TOOL_RECOVERED: 25,
  CONFUSION_SIGNAL: 50,
};

const BASE_SCOPE: Record<TriggerName, Exclude<Scope, "NONE">> = {
  INITIAL_GOAL: "FULL",
  HIGH_PREDICTION_ERROR: "FULL",
  AVAILABILITY_CHANGE: "FULL",
  MISSED_STREAK: "FULL",
  DEADLINE_RISK: "FULL",
  LOW_SCORE: "PATCH", // → FULL if >=2 subtopics affected, applied below
  ACTIVE_RECALL_FAILURE: "PATCH",
  MISSED_SESSION: "PATCH",
  CALENDAR_CONFLICT: "PATCH",
  RESOURCE_FAILURE: "PATCH",
  TOOL_RECOVERED: "PATCH",
  CONFUSION_SIGNAL: "PATCH", // asking is evidence of uncertainty → test, don't assume (v4 §N7.1)
};

export const DEBOUNCE_WINDOW_HOURS = 6;
export const CONFUSION_MIN_QUESTIONS = 2;
export const CONFUSION_WINDOW_HOURS = 48;
export const CONFUSION_MAX_CONFIDENCE = 0.70;

/** ≥2 TUTOR_QUESTION_ASKED on one subtopic within 48 simulated hours while confidence < 0.70. Pure; zero LLM calls. */
export function findConfusedSubtopics(observations: Observation[], now: Date): string[] {
  const bySubtopic = new Map<string, Array<{ at: number; confidence: number }>>();
  for (const o of observations) {
    if (o.type !== "TUTOR_QUESTION_ASKED") continue;
    const p = o.payload as { subtopic_id?: string; confidence?: number };
    if (!p.subtopic_id) continue;
    const at = o.at.getTime();
    if (now.getTime() - at > CONFUSION_WINDOW_HOURS * 3_600_000 || at > now.getTime()) continue;
    bySubtopic.set(p.subtopic_id, [...(bySubtopic.get(p.subtopic_id) ?? []), { at, confidence: p.confidence ?? 0 }]);
  }
  const out: string[] = [];
  for (const [subtopic, asks] of bySubtopic) {
    const latest = asks.sort((a, b) => a.at - b.at)[asks.length - 1];
    if (asks.length >= CONFUSION_MIN_QUESTIONS && latest.confidence < CONFUSION_MAX_CONFIDENCE) out.push(subtopic);
  }
  return out.sort();
}

export type TriggerInput = {
  now: Date;
  hasActivePlan: boolean;
  observations: Observation[];

  // MISSED_STREAK / MISSED_SESSION
  missedInLast7d: number;
  attendance14d: number | null; // completed / (completed + missed) over the trailing 14 sim days

  // DEADLINE_RISK
  bufferDays: number | null; // null when there's no active plan/goal to project

  // HIGH_PREDICTION_ERROR / LOW_SCORE, from unprocessed assessments this tick
  significantPredictionErrors: Array<{ subtopic_id: string; prediction_error: number }>;
  lowScoreSubtopics: Array<{ subtopic_id: string; score: number }>;

  // ACTIVE_RECALL_FAILURE — either an actual recall/retest scored low, or a forecasted dip
  recallFailures: Array<{ subtopic_id: string; recall_score: number }>;
  preemptiveRecallSubtopics: string[];

  // CALENDAR_CONFLICT / RESOURCE_FAILURE / TOOL_RECOVERED — read straight off observations,
  // but summarised here so the caller doesn't have to re-derive them from raw payloads.
  calendarConflicts: Array<{ activity_id: string; subtopic_id: string }>;
  resourceFailures: Array<{ resource_id: string }>;
  recoveredTools: string[];

  // AVAILABILITY_CHANGE
  availabilityDeltaRatio: number | null; // null when nothing changed
  deadlineMoved: boolean;

  // debounce: last time each trigger class fired, from recent agent_runs
  recentlyFiredAt: Partial<Record<TriggerName, Date>>;
};

function fire(name: TriggerName, detail: string, scopeOverride?: Exclude<Scope, "NONE">): FiredTrigger {
  return { name, severity: SEVERITY[name], scope: scopeOverride ?? BASE_SCOPE[name], detail };
}

function hoursBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 3_600_000;
}

export function evaluateTriggers(input: TriggerInput): TriggerDecision {
  const candidates: FiredTrigger[] = [];

  if (!input.hasActivePlan) {
    candidates.push(fire("INITIAL_GOAL", "No plan exists for the active goal."));
  }

  for (const e of input.significantPredictionErrors) {
    candidates.push(
      fire("HIGH_PREDICTION_ERROR", `${e.subtopic_id}: prediction error ${e.prediction_error.toFixed(2)} exceeds the 0.15 threshold.`),
    );
  }

  if (input.availabilityDeltaRatio !== null && (input.availabilityDeltaRatio > 0.20 || input.deadlineMoved)) {
    candidates.push(
      fire(
        "AVAILABILITY_CHANGE",
        input.deadlineMoved
          ? "Deadline moved."
          : `Weekly availability changed by ${(input.availabilityDeltaRatio * 100).toFixed(0)}%.`,
      ),
    );
  } else if (input.deadlineMoved) {
    candidates.push(fire("AVAILABILITY_CHANGE", "Deadline moved."));
  }

  if (input.missedInLast7d >= 3 || (input.attendance14d !== null && input.attendance14d < 0.60)) {
    candidates.push(
      fire(
        "MISSED_STREAK",
        input.missedInLast7d >= 3
          ? `${input.missedInLast7d} sessions missed in the last 7 days.`
          : `Attendance over 14 days is ${(input.attendance14d! * 100).toFixed(0)}%, below the 60% floor.`,
      ),
    );
  } else if (input.missedInLast7d >= 1) {
    candidates.push(fire("MISSED_SESSION", `${input.missedInLast7d} session missed.`));
  }

  if (input.bufferDays !== null && input.bufferDays < 3) {
    candidates.push(fire("DEADLINE_RISK", `Only ${input.bufferDays.toFixed(1)} buffer days remain before the deadline.`));
  }

  if (input.lowScoreSubtopics.length > 0) {
    const scope = input.lowScoreSubtopics.length >= 2 ? "FULL" : "PATCH";
    candidates.push(
      fire(
        "LOW_SCORE",
        `Score below 0.5 on a weighted subtopic: ${input.lowScoreSubtopics.map((s) => s.subtopic_id).join(", ")}.`,
        scope,
      ),
    );
  }

  for (const r of input.recallFailures) {
    candidates.push(fire("ACTIVE_RECALL_FAILURE", `${r.subtopic_id}: recall scored ${r.recall_score.toFixed(2)}, below 0.5.`));
  }
  for (const s of input.preemptiveRecallSubtopics) {
    candidates.push(fire("ACTIVE_RECALL_FAILURE", `${s}: retention forecast has fallen below target x0.8 — scheduling recall pre-emptively.`));
  }

  for (const c of input.calendarConflicts) {
    candidates.push(fire("CALENDAR_CONFLICT", `New external event overlaps ${c.subtopic_id} (activity ${c.activity_id}).`));
  }
  for (const r of input.resourceFailures) {
    candidates.push(fire("RESOURCE_FAILURE", `Resource ${r.resource_id} is unhelpful, dead, or unreachable.`));
  }
  for (const t of input.recoveredTools) {
    candidates.push(fire("TOOL_RECOVERED", `${t} recovered — re-planning any provisional activities.`));
  }

  const confused = findConfusedSubtopics(input.observations, input.now);
  if (confused.length > 0) {
    candidates.push({
      ...fire("CONFUSION_SIGNAL", `Asked the tutor about ${confused.join(", ")} at least ${CONFUSION_MIN_QUESTIONS} times in ${CONFUSION_WINDOW_HOURS}h with confidence below ${CONFUSION_MAX_CONFIDENCE} — scheduling a test rather than assuming.`),
      subtopic_ids: confused,
    });
  }

  // ---- debounce: drop a repeat of the same class within the window, but record it -------
  const debounced: TriggerName[] = [];
  const kept: FiredTrigger[] = [];
  const seenNames = new Set<TriggerName>();
  for (const c of candidates) {
    if (seenNames.has(c.name)) continue; // same-tick duplicates (e.g. two low-score subtopics) already merged above
    seenNames.add(c.name);
    const last = input.recentlyFiredAt[c.name];
    if (last && hoursBetween(last, input.now) < DEBOUNCE_WINDOW_HOURS) {
      debounced.push(c.name);
      continue;
    }
    kept.push(c);
  }

  if (kept.length === 0) {
    const reasonParts: string[] = [];
    if (input.attendance14d !== null) reasonParts.push(`attendance ${(input.attendance14d * 100).toFixed(0)}%`);
    if (input.bufferDays !== null) reasonParts.push(`buffer ${input.bufferDays.toFixed(1)}d`);
    reasonParts.push(`${input.missedInLast7d} missed`);
    const debouncedNote = debounced.length > 0 ? ` (${debounced.length} debounced: ${debounced.join(", ")})` : "";
    return {
      scope: "NONE",
      triggers: [],
      reason: `Tick at ${input.now.toISOString()} — ${reasonParts.join(", ")}, no trigger above threshold.${debouncedNote} No action needed.`,
      debounced,
    };
  }

  const scopeRank: Record<Exclude<Scope, "NONE">, number> = { NEGOTIATE: 3, FULL: 2, PATCH: 1 };
  const finalScope = kept.reduce<Exclude<Scope, "NONE">>((best, t) => (scopeRank[t.scope] > scopeRank[best] ? t.scope : best), "PATCH");

  const sortedByseverity = [...kept].sort((a, b) => b.severity - a.severity || a.name.localeCompare(b.name));
  const names = sortedByseverity.map((t) => t.name);
  const coalescedNote = kept.length > 1 ? `${kept.length} triggers coalesced → ${finalScope}: ${names.join(", ")}.` : `${names[0]} → ${finalScope}.`;
  const debouncedNote = debounced.length > 0 ? ` (${debounced.length} debounced: ${debounced.join(", ")})` : "";
  const reason = `${coalescedNote} ${sortedByseverity.map((t) => t.detail).join(" ")}${debouncedNote}`.trim();

  const decision: TriggerDecision = { scope: finalScope, triggers: sortedByseverity, reason, debounced };

  if (finalScope === "PATCH") {
    decision.patch_operations = buildPatchOps(sortedByseverity);
  }

  return decision;
}

/** Maps a PATCH-scope trigger set to the bounded operation(s) that address it. Never touches
 * the full planner — see bloom-phase6-brief §5.4: "PATCH must not call buildPlan." */
function buildPatchOps(triggers: FiredTrigger[]): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const t of triggers) {
    switch (t.name) {
      case "MISSED_SESSION":
      case "CALENDAR_CONFLICT":
        ops.push({ op: "RESCHEDULE_ACTIVITY", params: {} });
        break;
      case "ACTIVE_RECALL_FAILURE":
        ops.push({ op: "INSERT_ACTIVITY", params: {} });
        break;
      case "RESOURCE_FAILURE":
      case "TOOL_RECOVERED":
        ops.push({ op: "SWAP_RESOURCE", params: {} });
        break;
      case "LOW_SCORE":
        ops.push({ op: "INSERT_ACTIVITY", params: {} });
        break;
      case "CONFUSION_SIGNAL":
        for (const s of t.subtopic_ids ?? []) ops.push({ op: "INSERT_ACTIVITY", params: { action: "IMMEDIATE_TEST", subtopic_id: s } });
        break;
      default:
        break;
    }
  }
  return ops;
}
