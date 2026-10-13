/**
 * Phase 4 §10's "one extra check": build a plan for the seeded student and
 * read it as a day-by-day timeline, the way a human would. Property tests
 * prove the plan is legal; this is the only way to tell whether it's also
 * sensible. Uses the seed JSON directly — no DB — so it also works before
 * `npm run seed` has ever been run.
 *
 *   npx tsx src/scripts/print-plan.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildGapTable } from "../core/gapEngine.js";
import { rankResources } from "../core/resourceFit.js";
import { generateSlots } from "../core/slotter.js";
import { buildPlan } from "../core/planner.js";
import type {
  BusyInterval,
  FormatEfficacy,
  GapEngineInput,
  LearningGoal,
  RecallProposal,
  ResourceCandidate,
  ScoredResource,
  StudentConstraintsInput,
  SubtopicBelief,
  TopicGraph,
} from "../core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedDir = join(__dirname, "../db/seed/data");
function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(seedDir, name), "utf8")) as T;
}

type SeedSubtopic = { id: string; topicId: string; name: string; weight: number; baseHours: number; difficulty: number; concepts: string[] };
type SeedResource = { id: string; subtopicId: string; type: string; difficulty: number; durationMin: number; quality: number; conceptIds: string[]; title: string };
type SeedPrereqs = { subtopic: Array<{ subtopicId: string; prereqId: string }> };
type SeedStudent = {
  student: { simNow: string };
  constraints: { weeklyAvailability: Record<string, Array<{ start: string; end: string }>>; maxDailyStudyMin: number; minSessionMin: number; maxSessionMin: number };
  calendarEvents: Array<{ title: string; startsAt: string; endsAt: string }>;
};

const allSubtopics = loadJson<SeedSubtopic[]>("subtopics.json");
const allResources = loadJson<SeedResource[]>("resources.json");
const prereqs = loadJson<SeedPrereqs>("prerequisites.json");
const studentSeed = loadJson<SeedStudent>("student.json");

const subtopics = allSubtopics.filter((s) => s.topicId === "arrays");
const subtopicIds = subtopics.map((s) => s.id);
const byId = new Map(subtopics.map((s) => [s.id, s]));

const simNow = new Date(studentSeed.student.simNow);
const deadline = new Date(simNow.getTime() + 45 * 86_400_000);

// A hand-built, deliberately varied student state: one subtopic already mastered (just
// needs a checkpoint), one mid-progress with decent retention (PRACTICE), one with thin
// evidence on a meaningful subtopic (IMMEDIATE_TEST — the demo point from §3.3), one never
// opened (LEARN), and one studied but decayed (ACTIVE_RECALL).
const studentState: Record<
  string,
  { mu: number; confidence: number; learn_rate: number; evidence_count: number; has_completed_learning: boolean; retention_estimate: number }
> = {
  arr_traversal: { mu: 0.85, confidence: 0.80, learn_rate: 0.12, evidence_count: 8, has_completed_learning: true, retention_estimate: 0.80 },
  arr_prefix_sum: { mu: 0.55, confidence: 0.55, learn_rate: 0.11, evidence_count: 6, has_completed_learning: true, retention_estimate: 0.65 },
  arr_two_pointer: { mu: 0.20, confidence: 0.25, learn_rate: 0.09, evidence_count: 1, has_completed_learning: false, retention_estimate: 0.15 },
  arr_sliding_window: { mu: 0.0, confidence: 0.0, learn_rate: 0.08, evidence_count: 0, has_completed_learning: false, retention_estimate: 0.0 },
  arr_binary_search: { mu: 0.30, confidence: 0.40, learn_rate: 0.10, evidence_count: 6, has_completed_learning: true, retention_estimate: 0.35 },
};

const unmasteredDependentCount = new Map<string, number>();
for (const id of subtopicIds) {
  const dependents = prereqs.subtopic.filter((p) => p.prereqId === id && subtopicIds.includes(p.subtopicId));
  const unmastered = dependents.filter((d) => (studentState[d.subtopicId]?.mu ?? 0) < 0.75).length;
  unmasteredDependentCount.set(id, unmastered);
}

const TARGET_MASTERY = 0.75;
const gapInputs: GapEngineInput[] = subtopics.map((s) => {
  const state = studentState[s.id];
  return {
    subtopic_id: s.id,
    mu: state.mu,
    confidence: state.confidence,
    learn_rate: state.learn_rate,
    target_mastery: TARGET_MASTERY,
    blueprint_weight: s.weight,
    retention_estimate: state.retention_estimate,
    unmastered_dependent_count: unmasteredDependentCount.get(s.id) ?? 0,
    days_until_needed: 45 - s.difficulty * 5, // harder / more central subtopics pulled earlier
    evidence_count: state.evidence_count,
    has_completed_learning: state.has_completed_learning,
    is_repeated_weakness: false,
    all_learn_practice_complete: state.mu >= TARGET_MASTERY,
    has_final_test: false,
  };
});

const gapTable = buildGapTable(gapInputs);

const beliefs: SubtopicBelief[] = subtopics.map((s) => {
  const state = studentState[s.id];
  return {
    subtopic_id: s.id,
    mu: state.mu,
    confidence: state.confidence,
    learn_rate: state.learn_rate,
    evidence_count: state.evidence_count,
    assessment_count: state.evidence_count > 0 ? 1 : 0,
    last_observed_at: null,
    mu_at_last_observation: state.mu,
    hours_since_last_observation: 0,
    prediction_error_ema: 0,
    format_efficacy: { video: 0.05, article: 0.12, practice: 0.18, doc: 0.10, course: 0.10 },
    retention_estimate: state.retention_estimate,
    strength_days: 5,
  };
});

const FORMAT_EFFICACY: FormatEfficacy = { video: 0.05, article: 0.12, practice: 0.18, doc: 0.10, course: 0.10 };
const resourceCandidates = new Map<string, ScoredResource[]>();
for (const s of subtopics) {
  const focusConcept = s.concepts[0];
  const candidates: ResourceCandidate[] = allResources
    .filter((r) => r.subtopicId === s.id)
    .map((r) => ({
      id: r.id,
      type: r.type as ResourceCandidate["type"],
      difficulty: r.difficulty as ResourceCandidate["difficulty"],
      duration_min: r.durationMin,
      quality: r.quality,
      blacklisted: false,
      already_consumed: false,
      covers_focus_concept: r.conceptIds.includes(focusConcept),
    }));
  resourceCandidates.set(s.id, rankResources(candidates, studentState[s.id].mu, 30, FORMAT_EFFICACY, 3));
}

const topicGraph: TopicGraph = {
  subtopic_ids: subtopicIds,
  prerequisites: prereqs.subtopic.filter((p) => subtopicIds.includes(p.subtopicId) && subtopicIds.includes(p.prereqId)).map((p) => ({ subtopic_id: p.subtopicId, prereq_id: p.prereqId })),
  base_hours: Object.fromEntries(subtopics.map((s) => [s.id, s.baseHours])),
};

const goal: LearningGoal = {
  subject_id: "dsa",
  deadline,
  blueprint: Object.fromEntries(subtopics.map((s) => [s.id, s.weight])),
  target_mastery: Object.fromEntries(subtopics.map((s) => [s.id, TARGET_MASTERY])),
  must_have_subtopics: [],
};

const constraints: StudentConstraintsInput = {
  weekly_availability: studentSeed.constraints.weeklyAvailability,
  max_daily_study_min: studentSeed.constraints.maxDailyStudyMin,
  min_session_min: studentSeed.constraints.minSessionMin,
  max_session_min: studentSeed.constraints.maxSessionMin,
  blackout_dates: [],
};
const busyEvents: BusyInterval[] = studentSeed.calendarEvents.map((e) => ({ start: new Date(e.startsAt), end: new Date(e.endsAt) }));
const slots = generateSlots(constraints, busyEvents, simNow, deadline, {});

const recallProposals: RecallProposal[] = [
  { subtopic_id: "arr_traversal", due_at: new Date(simNow.getTime() + 10 * 86_400_000), urgency: 0.5, reason: "scheduled_interval", suggested_duration_min: 15, interval_index: 0 },
];

const plan = buildPlan({
  goal,
  beliefs,
  gapTable,
  slots,
  resourceCandidates,
  recallProposals,
  topicGraph,
  simNow,
  degradedSignals: [],
});

// ---- print -----------------------------------------------------------------

console.log(`\nGap table (${subtopics.length} subtopics, target mastery ${TARGET_MASTERY}):\n`);
for (const g of [...gapTable].sort((a, b) => b.priority - a.priority)) {
  console.log(`  ${g.subtopic_id.padEnd(18)} priority=${g.priority.toFixed(1).padStart(5)}  action=${g.action}`);
}

console.log(`\nProjection: goal attainment ${(plan.projection.projected_goal_attainment * 100).toFixed(1)}%, deficit ${plan.projection.deficit_hours.toFixed(1)}h`);
if (Object.keys(plan.projection.unplaced_hours).length > 0) {
  console.log("Unplaced hours:", plan.projection.unplaced_hours);
}

console.log(`\nDay-by-day timeline (${plan.activities.length} activities):\n`);
const byDay = new Map<string, typeof plan.activities>();
for (const a of plan.activities) {
  const day = a.start.toISOString().slice(0, 10);
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day)!.push(a);
}
for (const [day, activities] of [...byDay.entries()].sort()) {
  console.log(day);
  for (const a of activities) {
    const time = a.start.toISOString().slice(11, 16);
    const resource = a.resource_id ? allResources.find((r) => r.id === a.resource_id)?.title ?? a.resource_id : "—";
    console.log(
      `  ${time}  ${a.action.padEnd(14)} ${a.subtopic_id.padEnd(18)} ${String(a.duration_min).padStart(3)}min  pred=${a.predicted_score.toFixed(2)}  ${resource}`,
    );
  }
}
