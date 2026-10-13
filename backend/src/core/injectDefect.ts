/**
 * Deliberately breaks one constraint in an already-valid plan (bloom-
 * phase5-brief §8). Two uses: generating a plan that fails a specific
 * validator check without hand-crafting one (and having it drift from the
 * real plan shape as the schema evolves), and — later, once an orchestrator
 * exists — an `INJECT_DEFECT=capacity` demo hook that guarantees a
 * validation failure on cue instead of hoping the seeded scenario produces
 * one naturally.
 *
 * Pure: takes a valid Plan, returns a mutated one. Never silently no-ops —
 * each defect type requires at least one activity of the right shape to
 * exist, and throws if it can't find one, since a defect that fails to
 * inject would make a test believe it verified something it didn't.
 */

import type { Activity, DefectType, Plan, TopicGraph } from "./types.js";

export type InjectDefectContext = {
  deadline?: Date;
  topicGraph?: TopicGraph;
  maxDailyStudyMin?: number;
};

function requireActivity(plan: Plan, predicate: (a: Activity) => boolean, defect: DefectType): Activity {
  const found = plan.activities.find(predicate);
  if (!found) throw new Error(`injectDefect(${defect}): no activity in the plan matches the shape this defect needs to inject.`);
  return found;
}

function replace(plan: Plan, target: Activity, replacement: Activity | null, extra: Activity[] = []): Plan {
  const rest = plan.activities.filter((a) => a !== target);
  return { ...plan, activities: replacement ? [...rest, replacement, ...extra] : [...rest, ...extra] };
}

export function injectDefect(plan: Plan, defect: DefectType, ctx: InjectDefectContext = {}): Plan {
  switch (defect) {
    case "overlap": {
      if (plan.activities.length < 2) throw new Error("injectDefect(overlap): needs at least 2 activities.");
      const sorted = [...plan.activities].sort((a, b) => a.start.getTime() - b.start.getTime());
      const [first, second] = sorted;
      const forcedSecond: Activity = { ...second, start: first.start, end: first.end };
      return replace(plan, second, forcedSecond);
    }

    case "deadline": {
      const deadline = ctx.deadline ?? new Date(Math.max(...plan.activities.map((a) => a.end.getTime())));
      const target = requireActivity(plan, () => true, defect);
      const pushedEnd = new Date(deadline.getTime() + 3_600_000);
      const pushed: Activity = { ...target, start: new Date(pushedEnd.getTime() - target.duration_min * 60_000), end: pushedEnd };
      return replace(plan, target, pushed);
    }

    case "missing_final": {
      const started = new Set(plan.activities.filter((a) => a.action === "LEARN" || a.action === "PRACTICE").map((a) => a.subtopic_id));
      const target = requireActivity(plan, (a) => a.action === "FINAL_TEST" && started.has(a.subtopic_id), defect);
      return replace(plan, target, null);
    }

    case "prereq": {
      const graph = ctx.topicGraph;
      if (!graph) throw new Error("injectDefect(prereq): requires ctx.topicGraph.");
      const edge = graph.prerequisites[0];
      if (!edge) throw new Error("injectDefect(prereq): topicGraph has no prerequisite edges.");
      const dependent = requireActivity(plan, (a) => a.subtopic_id === edge.subtopic_id && (a.action === "LEARN" || a.action === "PRACTICE"), defect);
      const prereqActivity = plan.activities.find((a) => a.subtopic_id === edge.prereq_id && (a.action === "LEARN" || a.action === "PRACTICE"));
      if (!prereqActivity) throw new Error(`injectDefect(prereq): no activity found for prerequisite ${edge.prereq_id}.`);

      const dependentNew: Activity = { ...dependent, start: prereqActivity.start, end: prereqActivity.end };
      const prereqNew: Activity = { ...prereqActivity, start: dependent.start, end: dependent.end };
      const rest = plan.activities.filter((a) => a !== dependent && a !== prereqActivity);
      return { ...plan, activities: [...rest, dependentNew, prereqNew] };
    }

    case "capacity": {
      // Adds one extra activity on the busiest existing day rather than inflating one
      // activity's own duration — inflating a single activity risks also tripping C6's
      // session-length bound, which would muddy "this defect maps to exactly one check."
      // The caller picks a constraints.max_session_min comfortably above maxDailyStudyMin
      // if it wants this to trip C2 alone.
      const target = requireActivity(plan, () => true, defect);
      const dayKey = target.start.toISOString().slice(0, 10);
      const sameDay = plan.activities.filter((a) => a.start.toISOString().slice(0, 10) === dayKey);
      const dayTotal = sameDay.reduce((s, a) => s + a.duration_min, 0);
      const cap = ctx.maxDailyStudyMin ?? 120;
      const overflowMin = Math.max(1, cap - dayTotal + 1);
      const extraStart = new Date(Math.max(...sameDay.map((a) => a.end.getTime())));

      const extra: Activity = {
        ...target,
        action: "PRACTICE",
        resource_id: null,
        start: extraStart,
        end: new Date(extraStart.getTime() + overflowMin * 60_000),
        duration_min: overflowMin,
      };
      return { ...plan, activities: [...plan.activities, extra] };
    }
  }
}
