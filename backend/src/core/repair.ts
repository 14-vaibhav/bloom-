/**
 * Repairs a plan the validator rejected (bloom-phase5-brief §6). Seven
 * operators ordered cheapest-first; each is `(plan, failure, context) =>
 * Plan | null`, returning null when it doesn't apply so the loop falls
 * through to the next one. Capped at 3 rounds by a counter — not a
 * convergence check — and an oscillation guard (a repeated plan hash)
 * breaks early into negotiation rather than burning the remaining rounds.
 *
 * Repairs one failure class per round, highest-severity first (declaration
 * order in validator.ts's checks array — C1..C7 before L1..L5). Don't make
 * this smarter: SHIFT/SPLIT/SWAP/COMPRESS/DEFER are deliberately simple
 * time-arithmetic transforms, not a constraint solver.
 */

import { REPAIR } from "./constants.js";
import type {
  Activity,
  CheckId,
  CheckResult,
  Plan,
  RepairContext,
  RepairLogEntry,
  RepairOperatorName,
  RepairResult,
  StudentConstraintsInput,
  ValidatorState,
} from "./types.js";
import { validate } from "./validator.js";

// Must match validator.ts's ref() format exactly — see that file's header on why this is
// duplicated rather than imported (repair.ts isn't the validator, but reusing its exact
// composite-key convention here, inline, keeps the two files independently readable).
function activityRef(a: Activity): string {
  return `${a.subtopic_id}:${a.action}:${a.start.toISOString()}`;
}

function findOffending(plan: Plan, check: CheckResult): Activity[] {
  const refs = check.offending_activity_ids;
  if (!refs || refs.length === 0) return [];
  const set = new Set(refs);
  return plan.activities.filter((a) => set.has(activityRef(a)));
}

function isoDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type OperatorFn = (plan: Plan, check: CheckResult, ctx: RepairContext) => Plan | null;

// ---- SHIFT: move the offending activity to the next compatible slot ---------

function opShift(plan: Plan, check: CheckResult, ctx: RepairContext): Plan | null {
  const offending = findOffending(plan, check);
  if (offending.length === 0) return null;
  const target = [...offending].sort((a, b) => b.start.getTime() - a.start.getTime())[0];
  const deadline = ctx.validatorState.goal.deadline;
  const blackout = new Set(ctx.constraints.blackout_dates);
  const others = plan.activities.filter((a) => a !== target);

  for (let dayShift = 1; dayShift <= 14; dayShift++) {
    const ms = dayShift * 86_400_000;
    const moved: Activity = { ...target, start: new Date(target.start.getTime() + ms), end: new Date(target.end.getTime() + ms) };
    if (moved.end.getTime() >= deadline.getTime()) break;
    if (blackout.has(isoDayKey(moved.start))) continue;
    const conflicts = others.some((a) => moved.start.getTime() < a.end.getTime() && a.start.getTime() < moved.end.getTime());
    if (conflicts) continue;
    return { ...plan, activities: [...others, moved] };
  }
  return null;
}

// ---- SPLIT: break the activity into 2 fragments, second one the next day ----

function opSplit(plan: Plan, check: CheckResult, ctx: RepairContext): Plan | null {
  const offending = findOffending(plan, check);
  const target = offending[0];
  if (!target) return null;

  const firstMin = Math.round(target.duration_min * REPAIR.split_ratio);
  const secondMin = target.duration_min - firstMin;
  if (firstMin < 1 || secondMin < 1) return null;

  const firstHalf: Activity = { ...target, end: new Date(target.start.getTime() + firstMin * 60_000), duration_min: firstMin };
  const secondStart = new Date(target.start.getTime() + 86_400_000);
  const secondHalf: Activity = { ...target, start: secondStart, end: new Date(secondStart.getTime() + secondMin * 60_000), duration_min: secondMin };
  if (secondHalf.end.getTime() >= ctx.validatorState.goal.deadline.getTime()) return null;

  const rest = plan.activities.filter((a) => a !== target);
  const conflicts = (act: Activity) => rest.some((o) => act.start.getTime() < o.end.getTime() && o.start.getTime() < act.end.getTime());
  if (conflicts(firstHalf) || conflicts(secondHalf)) return null;
  return { ...plan, activities: [...rest, firstHalf, secondHalf] };
}

// ---- SWAP: exchange position with another activity ---------------------------

/** Exchanges two activities' START times, each keeping its OWN duration — "exchange
 * position," like two people swapping seats, not swapping the seats' own sizes. That's
 * what lets this actually change a day's total minutes (§6.1's capacity use) or an
 * ordering (§6.1's C5 use); swapping the [start,end) pairs wholesale would just relabel
 * which activity sits in which slot, changing nothing the checks can see. Only applied
 * if the result actually leaves both conflict-free against everyone else — "if both
 * still fit" (§6, closing paragraph). */
function swapTimes(plan: Plan, a: Activity, b: Activity): Plan | null {
  const aNew: Activity = { ...a, start: b.start, end: new Date(b.start.getTime() + a.duration_min * 60_000) };
  const bNew: Activity = { ...b, start: a.start, end: new Date(a.start.getTime() + b.duration_min * 60_000) };
  const rest = plan.activities.filter((x) => x !== a && x !== b);
  const conflicts = (act: Activity) => rest.some((o) => act.start.getTime() < o.end.getTime() && o.start.getTime() < act.end.getTime());
  if (conflicts(aNew) || conflicts(bNew)) return null;
  return { ...plan, activities: [...rest, aNew, bNew] };
}

function opSwap(plan: Plan, check: CheckResult, ctx: RepairContext): Plan | null {
  const offending = findOffending(plan, check);
  const target = offending[0];
  if (!target) return null;

  if (check.id === "C5") {
    const prereqsOf = new Map<string, string[]>();
    for (const e of ctx.validatorState.topicGraph.prerequisites) {
      prereqsOf.set(e.subtopic_id, [...(prereqsOf.get(e.subtopic_id) ?? []), e.prereq_id]);
    }
    const prereqIds = new Set(prereqsOf.get(target.subtopic_id) ?? []);
    const candidates = plan.activities.filter((a) => prereqIds.has(a.subtopic_id) && a.start.getTime() > target.start.getTime());
    const partner = [...candidates].sort((a, b) => a.start.getTime() - b.start.getTime())[0];
    if (!partner) return null;
    return swapTimes(plan, target, partner);
  }

  // For C1/C2, only swap with a genuine third party — swapping with the other half of the
  // same conflict just relabels which activity sits in the bad slot, so it never helps.
  const offendingSet = new Set(offending);
  const others = plan.activities.filter((a) => !offendingSet.has(a));
  const partner = [...others].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
  if (!partner) return null;
  return swapTimes(plan, target, partner);
}

// ---- SUBSTITUTE: drop the over-long resource, keep the activity -------------

function opSubstitute(plan: Plan, check: CheckResult): Plan | null {
  if (check.id !== "C4") return null;
  const offending = findOffending(plan, check);
  if (offending.length === 0) return null;
  const offendingSet = new Set(offending);
  const activities = plan.activities.map((a) => (offendingSet.has(a) ? { ...a, resource_id: null } : a));
  return { ...plan, activities };
}

// ---- COMPRESS: shrink the offending activity to 0.6x its duration -----------

function opCompress(plan: Plan, check: CheckResult, ctx: RepairContext): Plan | null {
  const offending = findOffending(plan, check);
  const target = offending[0];
  if (!target) return null;
  const newDuration = Math.max(1, Math.round(target.duration_min * REPAIR.compress_ratio));
  if (newDuration >= target.duration_min) return null;
  const compressed: Activity = { ...target, end: new Date(target.start.getTime() + newDuration * 60_000), duration_min: newDuration };
  // Compressing only helps a C3 (past-deadline) failure when the activity straddles the
  // deadline. If `start` itself is already past it, shrinking duration can never bring
  // `end` back before it — verify, or fall through to DEFER.
  if (check.id === "C3" && compressed.end.getTime() > ctx.validatorState.goal.deadline.getTime()) return null;
  const rest = plan.activities.filter((a) => a !== target);
  return { ...plan, activities: [...rest, compressed] };
}

// ---- DEFER: drop the offending subtopic entirely, unless it's a must-have ---

function opDefer(plan: Plan, check: CheckResult, ctx: RepairContext): Plan | null {
  const offending = findOffending(plan, check);
  const target = offending[0];
  if (!target) return null;
  if (ctx.validatorState.goal.must_have_subtopics.includes(target.subtopic_id)) return null;
  const activities = plan.activities.filter((a) => a.subtopic_id !== target.subtopic_id);
  if (activities.length === plan.activities.length) return null;
  return { ...plan, activities };
}

export const operators: Record<Exclude<RepairOperatorName, "NEGOTIATE">, OperatorFn> = {
  SHIFT: opShift,
  SPLIT: opSplit,
  SWAP: opSwap,
  SUBSTITUTE: opSubstitute,
  COMPRESS: opCompress,
  DEFER: opDefer,
};

const OPERATOR_ORDER: Array<{ name: Exclude<RepairOperatorName, "NEGOTIATE">; applicableTo: CheckId[] }> = [
  { name: "SHIFT", applicableTo: ["C1", "C2", "C6"] },
  { name: "SPLIT", applicableTo: ["C2", "C4", "C6"] },
  { name: "SWAP", applicableTo: ["C1", "C2", "C5"] },
  { name: "SUBSTITUTE", applicableTo: ["C4"] },
  { name: "COMPRESS", applicableTo: ["C2", "C3"] },
  { name: "DEFER", applicableTo: ["C3", "C7"] },
];

function planHash(plan: Plan): string {
  return [...plan.activities]
    .map((a) => `${a.subtopic_id}|${a.action}|${a.start.toISOString()}|${a.end.toISOString()}|${a.resource_id ?? ""}`)
    .sort()
    .join(";");
}

function describeRepair(operator: RepairOperatorName, check: CheckResult, before: Plan, after: Plan): string {
  const beforeRefs = new Set(before.activities.map(activityRef));
  const afterRefs = new Set(after.activities.map(activityRef));
  const added = after.activities.filter((a) => !beforeRefs.has(activityRef(a))).length;
  const removed = before.activities.filter((a) => !afterRefs.has(activityRef(a))).length;
  return `Applied ${operator} to satisfy ${check.id} (${check.name}): ${removed} activities changed, ${added} replacements scheduled. ${check.detail ?? ""}`.trim();
}

export function runValidationLoop(plan: Plan, validatorState: ValidatorState, constraints: StudentConstraintsInput): RepairResult {
  const ctx: RepairContext = { validatorState, constraints };
  let currentPlan = plan;
  const log: RepairLogEntry[] = [];
  const seenHashes = new Set<string>([planHash(plan)]);

  for (let round = 1; round <= REPAIR.max_rounds; round++) {
    const report = validate(currentPlan, validatorState, constraints, round);

    if (report.route === "negotiate") {
      return { plan: currentPlan, rounds: round - 1, log, finalReport: report, route: "negotiate" };
    }
    if (report.hard_failures === 0) {
      return { plan: currentPlan, rounds: round - 1, log, finalReport: report, route: "commit" };
    }

    const failing = report.checks.find((c) => c.status === "fail" && c.id !== "L5");
    if (!failing) {
      return { plan: currentPlan, rounds: round - 1, log, finalReport: report, route: "negotiate" };
    }

    const applicableOps = OPERATOR_ORDER.filter((op) => op.applicableTo.includes(failing.id));
    let applied: Plan | null = null;
    let usedOperator: RepairOperatorName | null = null;
    for (const op of applicableOps) {
      const result = operators[op.name](currentPlan, failing, ctx);
      if (result) {
        applied = result;
        usedOperator = op.name;
        break;
      }
    }

    if (!applied || !usedOperator) {
      return { plan: currentPlan, rounds: round - 1, log, finalReport: report, route: "negotiate" };
    }

    const hash = planHash(applied);
    if (seenHashes.has(hash)) {
      log.push({
        round,
        operator: usedOperator,
        check_id: failing.id,
        detail: `Oscillation detected — ${usedOperator} on ${failing.id} reproduced a prior plan state. Breaking early to negotiate.`,
      });
      return { plan: currentPlan, rounds: round, log, finalReport: report, route: "negotiate" };
    }
    seenHashes.add(hash);

    log.push({ round, operator: usedOperator, check_id: failing.id, detail: describeRepair(usedOperator, failing, currentPlan, applied) });
    currentPlan = applied;
  }

  const finalReport = validate(currentPlan, validatorState, constraints, REPAIR.max_rounds);
  return {
    plan: currentPlan,
    rounds: REPAIR.max_rounds,
    log,
    finalReport,
    route: finalReport.hard_failures === 0 && finalReport.route !== "negotiate" ? "commit" : "negotiate",
  };
}
