/**
 * Produces a plan plus a statement of what cannot be achieved and what
 * would fix it (bloom-phase5-brief §7). Deterministic — the wording is
 * Phase 7's Strategist; the numbers are here and must never change under
 * an LLM rewrite.
 *
 * The corrected worked example (§7.3): PRD v3's own example recommended
 * "+45 min/day" against a 20h deficit over 12 days, which only closes 9 of
 * the 20 hours. The formulas below are the ones that actually produce a
 * closing recommendation — verified against the brief's corrected numbers
 * (24h required, 18h available, 12 days, 1.5h/day current -> cost_A=0.571,
 * cost_B=0.333, cost_C=1.100, recommends B).
 */

import { NEGOTIATE } from "./constants.js";
import type { Activity, NegotiateInput, NegotiationOption, NegotiationResult } from "./types.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function negotiate(input: NegotiateInput): NegotiationResult {
  const deficitHours = input.required_hours - input.available_hours;
  if (deficitHours <= 0) {
    throw new Error("negotiate() called with no deficit — the caller should never invoke this when required_hours <= available_hours.");
  }
  if (input.days_remaining <= 0) {
    throw new Error("negotiate() called with days_remaining <= 0.");
  }

  const mustHave = new Set(input.must_have_subtopics);
  const dropCandidates = input.drop_candidates.filter((c) => !mustHave.has(c.subtopic_id));

  const currentDailyHours = input.available_hours / input.days_remaining;
  const currentMinPerDay = currentDailyHours * 60;

  // ---- Option A: extend the deadline -----------------------------------------
  const slipDays = Math.ceil(deficitHours / currentDailyHours);
  const costA = slipDays / NEGOTIATE.cost_a_days_divisor;

  // ---- Option B: add daily time ------------------------------------------------
  const addedMinPerDay = Math.ceil((deficitHours * 60) / input.days_remaining);
  const costB = addedMinPerDay / currentMinPerDay;

  // ---- Option C: drop scope until required <= available -----------------------
  let hoursSaved = 0;
  let weightDropped = 0;
  const deferred: string[] = [];
  for (const candidate of dropCandidates) {
    if (hoursSaved >= deficitHours) break;
    hoursSaved += candidate.hours_needed;
    weightDropped += candidate.weight;
    deferred.push(candidate.subtopic_id);
  }
  const costC = weightDropped / NEGOTIATE.cost_c_weight_divisor;

  const options: NegotiationOption[] = [
    { label: "A", description: `Extend the deadline by ${slipDays} days.`, cost: round2(costA) },
    {
      label: "B",
      description: `Add ${addedMinPerDay} minutes a day, taking you from ${round2(currentMinPerDay)} to ${round2(currentMinPerDay + addedMinPerDay)} minutes.`,
      cost: round2(costB),
    },
    {
      label: "C",
      description:
        deferred.length > 0
          ? `Drop ${deferred.join(", ")} — ${round2(weightDropped * 100)}% of what the goal covers.`
          : "No non-must-have subtopics are available to drop.",
      cost: deferred.length > 0 ? round2(costC) : Number.POSITIVE_INFINITY,
    },
  ];

  const recommended = options.reduce((best, o) => (o.cost < best.cost ? o : best), options[0]).label;
  const reasons: Record<string, string> = {
    A: "smallest change that restores feasibility by moving the deadline.",
    B: "smallest change that closes the gap without dropping scope or moving the deadline.",
    C: "smallest change that closes the gap by dropping the least-valuable scope.",
  };

  const deferredSet = new Set(deferred);
  const bestPartialActivities: Activity[] = input.plan.activities.filter((a) => !deferredSet.has(a.subtopic_id));
  const bestPartialPlan = { ...input.plan, activities: bestPartialActivities };

  const protectedSubtopics = [...new Set(input.plan.activities.map((a) => a.subtopic_id))].filter((id) => !deferredSet.has(id));
  const protectedWeight = 1 - weightDropped;

  return {
    infeasible: true,
    deficit_hours: round2(deficitHours),
    best_partial_plan: bestPartialPlan,
    protected_subtopics: protectedSubtopics,
    protected_weight: round2(protectedWeight),
    deferred_subtopics: deferred,
    projected_attainment: input.plan.projection.projected_goal_attainment,
    options,
    recommended,
    recommendation_reason: `Option ${recommended} — ${reasons[recommended]}`,
  };
}
