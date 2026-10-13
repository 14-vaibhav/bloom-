/**
 * The four bounded PATCH operations (bloom-phase6-brief §5.4). Each is a pure
 * `(activities, slots, params) => result` — no DB, no tool calls — so a PATCH
 * touches at most a handful of activities and never calls buildPlan. The
 * orchestrator supplies `slots` from a single calendar.get_available_slots
 * call and persists the result via the same commit path a FULL replan uses.
 *
 * An activity carried through untouched keeps its own id as
 * `carried_from_activity_id` when the commit layer re-inserts it for the new
 * version — that's what let's the diff report "1 moved, N unchanged" instead
 * of reading as a full regeneration (§7.2-7.3).
 */

import type { ActionType, Slot } from "../core/types.js";

export type PatchActivity = {
  id: string; // current version's activity id
  subtopic_id: string;
  resource_id: string | null;
  action: ActionType;
  start: Date;
  end: Date;
  duration_min: number;
  priority: number | null;
  predicted_score: number | null;
  expected_mastery_after: number | null;
  provisional: boolean;
};

export type PatchResult = {
  activities: PatchActivity[]; // the full set for the new version (unchanged + changed + inserted)
  touched: string[]; // ids (existing) that changed, for the log line
  inserted: number; // count of brand-new activities with no prior id
};

function conflictsWithAny(start: Date, end: Date, others: PatchActivity[], excludeId?: string): boolean {
  return others.some((o) => o.id !== excludeId && start.getTime() < o.end.getTime() && o.start.getTime() < end.getTime());
}

function sortSlots(slots: Slot[]): Slot[] {
  return [...slots].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Moves one activity to the earliest available slot at/after `notBefore` that doesn't
 * conflict with any other CURRENT activity. Keeps the activity's own duration; a slot
 * longer than needed is simply not fully used (matches the planner's own convention). */
export function rescheduleActivity(
  activities: PatchActivity[],
  slots: Slot[],
  params: { activityId: string; notBefore: Date },
): PatchResult {
  const target = activities.find((a) => a.id === params.activityId);
  if (!target) return { activities, touched: [], inserted: 0 };

  const others = activities.filter((a) => a.id !== target.id);
  const slot = sortSlots(slots).find(
    (s) => s.start.getTime() >= params.notBefore.getTime() && s.duration_min >= target.duration_min && !conflictsWithAny(s.start, new Date(s.start.getTime() + target.duration_min * 60_000), others),
  );
  if (!slot) return { activities, touched: [], inserted: 0 };

  const newEnd = new Date(slot.start.getTime() + target.duration_min * 60_000);
  const moved: PatchActivity = { ...target, start: slot.start, end: newEnd };
  return { activities: [...others, moved], touched: [target.id], inserted: 0 };
}

/** Adds a brand-new activity (no lineage) into the earliest compatible free slot. */
export function insertActivity(
  activities: PatchActivity[],
  slots: Slot[],
  params: { subtopic_id: string; action: ActionType; duration_min: number; notBefore: Date; predicted_score: number; expected_mastery_after: number },
): PatchResult {
  const slot = sortSlots(slots).find(
    (s) => s.start.getTime() >= params.notBefore.getTime() && s.duration_min >= params.duration_min && !conflictsWithAny(s.start, new Date(s.start.getTime() + params.duration_min * 60_000), activities),
  );
  if (!slot) return { activities, touched: [], inserted: 0 };

  const end = new Date(slot.start.getTime() + params.duration_min * 60_000);
  const created: PatchActivity = {
    id: `new:${params.subtopic_id}:${params.action}:${slot.start.toISOString()}`, // synthetic — commit layer treats any id not in the prior version as "new"
    subtopic_id: params.subtopic_id,
    resource_id: null,
    action: params.action,
    start: slot.start,
    end,
    duration_min: params.duration_min,
    priority: null,
    predicted_score: params.predicted_score,
    expected_mastery_after: params.expected_mastery_after,
    provisional: false,
  };
  return { activities: [...activities, created], touched: [], inserted: 1 };
}

/** Replaces one activity's resource, keeping its slot untouched. Used both for
 * RESOURCE_FAILURE (swap to the next-best candidate) and TOOL_RECOVERED
 * (swap a provisional placeholder for the now-available real resource). */
export function swapResource(
  activities: PatchActivity[],
  params: { activityId: string; newResourceId: string | null; clearProvisional?: boolean },
): PatchResult {
  const target = activities.find((a) => a.id === params.activityId);
  if (!target) return { activities, touched: [], inserted: 0 };

  const swapped: PatchActivity = {
    ...target,
    resource_id: params.newResourceId,
    provisional: params.clearProvisional ? false : target.provisional,
  };
  return { activities: [...activities.filter((a) => a.id !== target.id), swapped], touched: [target.id], inserted: 0 };
}

/** Pushes a named set (<=5) of activities forward by N days, keeping their relative order
 * and duration. Silently drops an activity from the set if it no longer exists. */
export function deferActivities(activities: PatchActivity[], params: { activityIds: string[]; days: number }): PatchResult {
  const ids = new Set(params.activityIds.slice(0, 5));
  const ms = params.days * 86_400_000;
  const touched: string[] = [];
  const next = activities.map((a) => {
    if (!ids.has(a.id)) return a;
    touched.push(a.id);
    return { ...a, start: new Date(a.start.getTime() + ms), end: new Date(a.end.getTime() + ms) };
  });
  return { activities: next, touched, inserted: 0 };
}
