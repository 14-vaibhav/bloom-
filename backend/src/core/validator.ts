/**
 * Decides whether a plan is acceptable (bloom-phase5-brief §5). This file
 * MUST NOT import planner.ts or slotter.ts, and must not call any function
 * defined there — that is the entire point of having a validator. If both
 * the planner and the validator read the same overlap helper, a bug in that
 * helper produces plans that are wrong and validated as correct, which is
 * worse than no validator at all. Every date/interval helper below is its
 * own small reimplementation, deliberately duplicated. See test/core/
 * validator.test.ts's module-independence check, which fails loudly if this
 * file ever imports from planner.js or slotter.js.
 *
 * Pure: state snapshot in, report out. No DB, no clock, no tool calls —
 * Phase 9's chaos/eval harness runs this thousands of times.
 *
 * All intervals are half-open [start, end) — matching slotter.ts's own
 * convention by coincidence of correctness, not by sharing code with it.
 */

import { VALIDATOR } from "./constants.js";
import type {
  Activity,
  ActionType,
  BusyInterval,
  CheckId,
  CheckResult,
  GapEntry,
  LearningGoal,
  Plan,
  Route,
  StudentConstraintsInput,
  SubtopicBelief,
  TopicGraph,
  ValidationReport,
  ValidatorState,
} from "./types.js";

// ---- local, deliberately independent date helpers ---------------------------

function isoDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDayOfWeekKey(isoDay: string): string {
  return String(new Date(`${isoDay}T00:00:00Z`).getUTCDay());
}

function wallClockOnDay(isoDay: string, wallClock: string): Date {
  const [h, m] = wallClock.split(":").map(Number);
  const [y, mo, d] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m));
}

function ref(a: Activity): string {
  return `${a.subtopic_id}:${a.action}:${a.start.toISOString()}`;
}

function fail(id: CheckId, name: string, detail: string, offending: string[], operator?: CheckResult["suggested_operator"]): CheckResult {
  return { id, name, status: "fail", detail, offending_activity_ids: offending, suggested_operator: operator };
}

function warn(id: CheckId, name: string, detail: string, offending: string[] = []): CheckResult {
  return { id, name, status: "warn", detail, offending_activity_ids: offending };
}

function pass(id: CheckId, name: string): CheckResult {
  return { id, name, status: "pass" };
}

// ---- C1: no overlapping sessions (interval sweep) ----------------------------

function checkC1(activities: Activity[], externalEvents: BusyInterval[]): CheckResult {
  type Item = { start: Date; end: Date; r: string };
  const items: Item[] = [
    ...activities.map((a) => ({ start: a.start, end: a.end, r: ref(a) })),
    ...externalEvents.map((e, i) => ({ start: e.start, end: e.end, r: `external:${i}:${e.start.toISOString()}` })),
  ];
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());

  const offending = new Set<string>();
  let cursorEnd: Date | null = null;
  let cursorRef: string | null = null;
  for (const item of sorted) {
    if (cursorEnd && cursorRef && item.start.getTime() < cursorEnd.getTime()) {
      offending.add(item.r);
      offending.add(cursorRef);
    }
    if (!cursorEnd || item.end.getTime() > cursorEnd.getTime()) {
      cursorEnd = item.end;
      cursorRef = item.r;
    }
  }

  if (offending.size === 0) return pass("C1", "No overlapping sessions");
  return fail("C1", "No overlapping sessions", `${offending.size} activities overlap another session or a calendar event`, [...offending], "SHIFT");
}

// ---- C2: daily capacity + availability windows -------------------------------

function checkC2(activities: Activity[], constraints: StudentConstraintsInput): CheckResult {
  const byDay = new Map<string, Activity[]>();
  for (const a of activities) {
    const key = isoDayKey(a.start);
    byDay.set(key, [...(byDay.get(key) ?? []), a]);
  }

  const offending: string[] = [];
  const details: string[] = [];
  const blackout = new Set(constraints.blackout_dates);

  for (const [day, dayActivities] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    const total = dayActivities.reduce((s, a) => s + a.duration_min, 0);
    if (total > constraints.max_daily_study_min) {
      details.push(`${day} has ${total} min scheduled, cap is ${constraints.max_daily_study_min}`);
      dayActivities.forEach((a) => offending.push(ref(a)));
    }

    if (blackout.has(day)) continue; // C6 owns blackout-date failures; capacity/window checks are moot there.
    const windows = constraints.weekly_availability[utcDayOfWeekKey(day)] ?? [];
    for (const a of dayActivities) {
      const fits = windows.some((w) => {
        const ws = wallClockOnDay(day, w.start);
        const we = wallClockOnDay(day, w.end);
        return a.start.getTime() >= ws.getTime() && a.end.getTime() <= we.getTime();
      });
      if (!fits) {
        details.push(`${ref(a)} falls outside every availability window on ${day}`);
        offending.push(ref(a));
      }
    }
  }

  if (offending.length === 0) return pass("C2", "Daily capacity and availability windows respected");
  return fail("C2", "Daily capacity and availability windows respected", details.join("; "), offending, "SHIFT");
}

// ---- C3: all activities before deadline --------------------------------------

function checkC3(activities: Activity[], deadline: Date): CheckResult {
  const offending = activities.filter((a) => a.end.getTime() > deadline.getTime());
  if (offending.length === 0) return pass("C3", "All activities finish before the deadline");
  return fail(
    "C3",
    "All activities finish before the deadline",
    `${offending.length} activities end after ${deadline.toISOString()}`,
    offending.map(ref),
    "COMPRESS",
  );
}

// ---- C4: duration fits the slot (resource duration + buffer) -----------------

function checkC4(activities: Activity[], resourceDurations: Record<string, number>): CheckResult {
  const offending: Activity[] = [];
  const details: string[] = [];
  for (const a of activities) {
    if (!a.resource_id) continue;
    const resourceDuration = resourceDurations[a.resource_id];
    if (resourceDuration === undefined) continue;
    if (resourceDuration + VALIDATOR.resource_duration_buffer_min > a.duration_min) {
      offending.push(a);
      details.push(`${ref(a)}: ${resourceDuration}min resource in a ${a.duration_min}min slot`);
    }
  }
  if (offending.length === 0) return pass("C4", "Every resource fits its slot with a 5-minute buffer");
  return fail("C4", "Every resource fits its slot with a 5-minute buffer", details.join("; "), offending.map(ref), "SUBSTITUTE");
}

// ---- C5: prerequisite ordering ------------------------------------------------

function checkC5(activities: Activity[], topicGraph: TopicGraph, beliefs: SubtopicBelief[], goal: LearningGoal): CheckResult {
  const prereqsOf = new Map<string, string[]>();
  for (const e of topicGraph.prerequisites) {
    prereqsOf.set(e.subtopic_id, [...(prereqsOf.get(e.subtopic_id) ?? []), e.prereq_id]);
  }
  const beliefBySubtopic = new Map(beliefs.map((b) => [b.subtopic_id, b]));
  const activitiesBySubtopic = new Map<string, Activity[]>();
  for (const a of activities) {
    activitiesBySubtopic.set(a.subtopic_id, [...(activitiesBySubtopic.get(a.subtopic_id) ?? []), a]);
  }

  const offending: Activity[] = [];
  const details: string[] = [];
  const studyActions: ActionType[] = ["LEARN", "PRACTICE"];
  for (const a of activities) {
    if (!studyActions.includes(a.action)) continue;
    for (const prereqId of prereqsOf.get(a.subtopic_id) ?? []) {
      const belief = beliefBySubtopic.get(prereqId);
      const target = goal.target_mastery[prereqId] ?? 0;
      const mastered = belief ? belief.mu >= target * VALIDATOR.mastered_prereq_ratio : false;
      if (mastered) continue;

      const clearedEarlier = (activitiesBySubtopic.get(prereqId) ?? []).some((p) => p.end.getTime() <= a.start.getTime());
      if (!clearedEarlier) {
        offending.push(a);
        details.push(`${a.subtopic_id} (${ref(a)}) scheduled before prerequisite ${prereqId} is mastered or completed`);
      }
    }
  }

  if (offending.length === 0) return pass("C5", "Prerequisite ordering respected");
  return fail("C5", "Prerequisite ordering respected", details.join("; "), offending.map(ref), "SWAP");
}

// ---- C6: session bounds + blackout dates -------------------------------------

function checkC6(activities: Activity[], constraints: StudentConstraintsInput): CheckResult {
  const offending: Activity[] = [];
  const details: string[] = [];
  const blackout = new Set(constraints.blackout_dates);

  for (const a of activities) {
    if (a.duration_min < constraints.min_session_min || a.duration_min > constraints.max_session_min) {
      offending.push(a);
      details.push(`${ref(a)}: duration ${a.duration_min}min outside [${constraints.min_session_min},${constraints.max_session_min}]`);
    }
    const day = isoDayKey(a.start);
    if (blackout.has(day)) {
      offending.push(a);
      details.push(`${ref(a)}: falls on blackout date ${day}`);
    }
  }

  if (offending.length === 0) return pass("C6", "Session bounds and blackout dates respected");
  return fail("C6", "Session bounds and blackout dates respected", details.join("; "), offending.map(ref), "SHIFT");
}

// ---- C7: every started subtopic has a scheduled FINAL_TEST -------------------

function checkC7(activities: Activity[]): CheckResult {
  const started = new Set(activities.filter((a) => a.action === "LEARN" || a.action === "PRACTICE").map((a) => a.subtopic_id));
  const hasFinal = new Set(activities.filter((a) => a.action === "FINAL_TEST").map((a) => a.subtopic_id));
  const missing = [...started].filter((id) => !hasFinal.has(id));

  if (missing.length === 0) return pass("C7", "Every started subtopic has a scheduled final test");
  return fail(
    "C7",
    "Every started subtopic has a scheduled final test",
    `Missing FINAL_TEST for: ${missing.sort().join(", ")}`,
    activities.filter((a) => missing.includes(a.subtopic_id)).map(ref),
    "DEFER",
  );
}

// ---- L1: top-3 priority gaps each have an activity ---------------------------

function checkL1(activities: Activity[], gapTable: GapEntry[]): CheckResult {
  const top3 = [...gapTable].sort((a, b) => b.priority - a.priority || a.subtopic_id.localeCompare(b.subtopic_id)).slice(0, VALIDATOR.top_gap_count);
  const covered = new Set(activities.map((a) => a.subtopic_id));
  const missing = top3.filter((g) => !covered.has(g.subtopic_id)).map((g) => g.subtopic_id);

  if (missing.length === 0) return pass("L1", "Top-3 priority gaps each have an activity");
  return fail("L1", "Top-3 priority gaps each have an activity", `No activity for: ${missing.join(", ")}`, []);
}

// ---- L2: every completed subtopic has ≥2 ACTIVE_RECALL -----------------------

function checkL2(activities: Activity[], beliefs: SubtopicBelief[], goal: LearningGoal, completedCounts: Record<string, number>): CheckResult {
  const recallInPlan = new Map<string, number>();
  for (const a of activities) {
    if (a.action !== "ACTIVE_RECALL") continue;
    recallInPlan.set(a.subtopic_id, (recallInPlan.get(a.subtopic_id) ?? 0) + 1);
  }

  const missing: string[] = [];
  for (const b of beliefs) {
    const target = goal.target_mastery[b.subtopic_id];
    if (target === undefined || b.mu < target) continue; // only "completed" (already at/above target) subtopics need retention checks
    const total = (completedCounts[b.subtopic_id] ?? 0) + (recallInPlan.get(b.subtopic_id) ?? 0);
    if (total < VALIDATOR.min_active_recall_for_completed) missing.push(b.subtopic_id);
  }

  if (missing.length === 0) return pass("L2", "Every completed subtopic has at least 2 active-recall sessions");
  return fail("L2", "Every completed subtopic has at least 2 active-recall sessions", `Fewer than 2 for: ${missing.sort().join(", ")}`, []);
}

// ---- L3: subtopics with mu < 0.5 have a REVISION or PRACTICE -----------------

function checkL3(activities: Activity[], beliefs: SubtopicBelief[]): CheckResult {
  const covered = new Set(activities.filter((a) => a.action === "REVISION" || a.action === "PRACTICE").map((a) => a.subtopic_id));
  const missing = beliefs.filter((b) => b.mu < VALIDATOR.low_mastery_threshold && !covered.has(b.subtopic_id)).map((b) => b.subtopic_id);

  if (missing.length === 0) return pass("L3", "Weak subtopics (mu < 0.5) have a revision or practice activity");
  return fail("L3", "Weak subtopics (mu < 0.5) have a revision or practice activity", `Missing for: ${missing.sort().join(", ")}`, []);
}

// ---- L4 (soft): practice + assessment minutes >= 30% of total ---------------

function checkL4(activities: Activity[]): CheckResult {
  const total = activities.reduce((s, a) => s + a.duration_min, 0);
  if (total === 0) return pass("L4", "Practice/assessment minutes are at least 30% of the plan");

  const nonLearn = activities.filter((a) => a.action !== "LEARN" && a.action !== "MILESTONE").reduce((s, a) => s + a.duration_min, 0);
  const ratio = nonLearn / total;
  if (ratio >= VALIDATOR.practice_assessment_min_ratio) return pass("L4", "Practice/assessment minutes are at least 30% of the plan");
  return warn("L4", "Practice/assessment minutes are at least 30% of the plan", `Only ${(ratio * 100).toFixed(1)}% of minutes are practice/assessment`);
}

// ---- L5: projected attainment >= target for must-have subtopics -> NEGOTIATE

function checkL5(plan: Plan, goal: LearningGoal): CheckResult {
  const failing = goal.must_have_subtopics.filter((id) => {
    const projected = plan.projection.projected_mastery_at_deadline[id] ?? 0;
    const target = goal.target_mastery[id] ?? 0;
    return projected < target;
  });

  if (failing.length === 0) return pass("L5", "Projected attainment meets target for every must-have subtopic");
  return fail(
    "L5",
    "Projected attainment meets target for every must-have subtopic",
    `Below target for: ${failing.sort().join(", ")}`,
    [],
    "NEGOTIATE",
  );
}

// ---- entry point --------------------------------------------------------------

export function validate(plan: Plan, state: ValidatorState, constraints: StudentConstraintsInput, repairRound = 0): ValidationReport {
  const checks: CheckResult[] = [
    checkC1(plan.activities, state.externalEvents),
    checkC2(plan.activities, constraints),
    checkC3(plan.activities, state.goal.deadline),
    checkC4(plan.activities, state.resourceDurations),
    checkC5(plan.activities, state.topicGraph, state.beliefs, state.goal),
    checkC6(plan.activities, constraints),
    checkC7(plan.activities),
    checkL1(plan.activities, state.gapTable),
    checkL2(plan.activities, state.beliefs, state.goal, state.completedActiveRecallCounts),
    checkL3(plan.activities, state.beliefs),
    checkL4(plan.activities),
    checkL5(plan, state.goal),
  ];

  const hardFailures = checks.filter((c) => c.status === "fail").length;
  const softWarnings = checks.filter((c) => c.status === "warn").length;
  const l5Failed = checks.find((c) => c.id === "L5")?.status === "fail";
  const route: Route = l5Failed ? "negotiate" : hardFailures > 0 ? "repair" : "commit";

  return {
    valid: hardFailures === 0,
    hard_failures: hardFailures,
    soft_warnings: softWarnings,
    repair_round: repairRound,
    checks,
    route,
  };
}
