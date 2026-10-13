/**
 * Lineage-based plan diff (bloom-phase6-brief §7.2-7.3). Matches strictly by
 * `carried_from_activity_id` — the fallback match on (subtopic_id, action)
 * for pre-lineage rows is deliberately not implemented: a fresh seed has no
 * activity created before lineage tracking existed, so it would never fire
 * (§14, "ship lineage-matching only").
 *
 * `unchanged_count` is the number that actually proves a PATCH stayed local —
 * without it every diff reads as "regenerated everything."
 */

export type ActivitySummary = {
  activity_id: string;
  subtopic_id: string;
  action: string;
  start: string; // ISO
  end: string; // ISO
  resource_id: string | null;
};

export type DiffBeforeActivity = ActivitySummary & { duration_min: number };
export type DiffAfterActivity = ActivitySummary & { duration_min: number; carried_from_activity_id: string | null };

export type PlanDiff = {
  added: ActivitySummary[];
  removed: ActivitySummary[];
  moved: Array<{ activity: ActivitySummary; from: string; to: string }>;
  modified: Array<{ activity: ActivitySummary; field: string; from: unknown; to: unknown }>;
  unchanged_count: number;
};

export function computePlanDiff(before: DiffBeforeActivity[], after: DiffAfterActivity[]): PlanDiff {
  const beforeById = new Map(before.map((b) => [b.activity_id, b]));
  const consumed = new Set<string>();

  const added: ActivitySummary[] = [];
  const moved: PlanDiff["moved"] = [];
  const modified: PlanDiff["modified"] = [];
  let unchangedCount = 0;

  for (const a of after) {
    const prior = a.carried_from_activity_id ? beforeById.get(a.carried_from_activity_id) : undefined;
    if (!prior) {
      added.push(strip(a));
      continue;
    }
    consumed.add(prior.activity_id);

    const summary = strip(a);
    if (prior.start !== a.start || prior.end !== a.end) {
      moved.push({ activity: summary, from: prior.start, to: a.start });
      continue;
    }
    if (prior.resource_id !== a.resource_id) {
      modified.push({ activity: summary, field: "resource_id", from: prior.resource_id, to: a.resource_id });
      continue;
    }
    if (prior.duration_min !== a.duration_min) {
      modified.push({ activity: summary, field: "duration_min", from: prior.duration_min, to: a.duration_min });
      continue;
    }
    unchangedCount++;
  }

  const removed = before.filter((b) => !consumed.has(b.activity_id)).map(strip);

  return { added, removed, moved, modified, unchanged_count: unchangedCount };
}

function strip(a: ActivitySummary): ActivitySummary {
  return { activity_id: a.activity_id, subtopic_id: a.subtopic_id, action: a.action, start: a.start, end: a.end, resource_id: a.resource_id };
}
