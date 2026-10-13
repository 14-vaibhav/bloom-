/**
 * Eval harness loop (bloom-phase9-brief §B3). Each synthetic student is a
 * REAL row in students/learning_goals/student_constraints — the harness
 * drives the actual tick(), composeAssessment() and submitAnswers() the
 * real product uses, and only the "what would a student have done" side
 * (attendance, correctness, true mastery) is simulated. That's the whole
 * point: the plan-validity, repair-round, scope and latency numbers this
 * produces are the real system's numbers, not a mock of them.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { learningActivities, learningGoals, planVersions, studentConstraints, students, studyPlans, subtopicMastery } from "../db/schema.js";
import { buildDefaultBlueprint, buildTopicGraph } from "../agent/assemble.js";
import { tick } from "../agent/orchestrator.js";
import { advanceSimClock, getSimNow } from "../agent/simClock.js";
import { composeAssessment, submitAnswers } from "../tools/qbank.js";
import { mulberry32, seedFrom, type Rng } from "./rng.js";
import { applyDailyForgetting, applyLearningGain, initSimStudent, simulateAnswer, simulateAttendance, type EvalProfile, type SimStudent } from "./simStudent.js";

const EVAL_START = new Date("2027-01-05T08:00:00Z"); // a Tuesday — clear of DST edge cases

export type AssessmentSample = { subtopic_id: string; predicted_score: number; actual_score: number; day: number };
export type TickSample = { day: number; scope: string; route: string | null; repair_rounds: number; latency_ms: number; outcome: string | null };

export type StudentResult = {
  studentId: string;
  profile: string;
  assessments: AssessmentSample[];
  ticks: TickSample[];
  finalMuBySubtopic: Record<string, number>;
  finalTrueMastery: Record<string, number>;
  goalAchieved: boolean;
};

function purposeFor(action: string): "immediate" | "active_recall" | "final" | null {
  if (action === "IMMEDIATE_TEST") return "immediate";
  if (action === "ACTIVE_RECALL") return "active_recall";
  if (action === "FINAL_TEST") return "final";
  return null;
}

async function createEvalStudent(opts: { runLabel: string; index: number; subjectId: string; profile: EvalProfile; days: number; seed: number }): Promise<{ student: SimStudent; goalId: string }> {
  const [studentRow] = await db.insert(students).values({
    name: `Eval ${opts.profile.name} #${opts.index}`,
    email: `eval-${opts.runLabel}-${opts.index}-${opts.profile.name}@bloom.sim`,
    simNow: EVAL_START,
  }).returning({ id: students.id });

  const topicGraph = await buildTopicGraph(opts.subjectId);
  const { blueprint, targetMastery } = await buildDefaultBlueprint(opts.subjectId);
  const deadline = new Date(EVAL_START.getTime() + opts.days * 86_400_000).toISOString().slice(0, 10);

  const [goal] = await db.insert(learningGoals).values({
    studentId: studentRow.id, subjectId: opts.subjectId, title: `Eval goal (${opts.profile.name})`,
    deadline, blueprint, targetMastery, mustHaveSubtopics: [],
  }).returning({ id: learningGoals.id });

  const weeklyAvailability = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "18:00", end: "20:00" }]]));
  await db.insert(studentConstraints).values({
    studentId: studentRow.id, weeklyAvailability, maxDailyStudyMin: 120, minSessionMin: 15, maxSessionMin: 90,
    blackoutDates: [], preferredFormats: [], effectiveFrom: EVAL_START,
  });

  const rng = mulberry32(opts.seed);
  const sim = initSimStudent(studentRow.id, opts.profile, topicGraph.subtopic_ids, rng);
  return { student: sim, goalId: goal.id };
}

async function applyAvailabilityShock(studentId: string, newDailyHours: number, now: Date): Promise<void> {
  const perDayMin = Math.round(newDailyHours * 60);
  const start = "18:00";
  const endMinutes = 18 * 60 + perDayMin;
  const end = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
  const weeklyAvailability = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start, end }]]));
  await db.insert(studentConstraints).values({
    studentId, weeklyAvailability, maxDailyStudyMin: perDayMin, minSessionMin: 15, maxSessionMin: Math.min(90, perDayMin),
    blackoutDates: [], preferredFormats: [], effectiveFrom: now,
  });
}

async function processActivitiesForToday(sim: SimStudent, studentId: string, now: Date, dayIndex: number, rng: Rng, samples: AssessmentSample[]): Promise<void> {
  const [plan] = await db.select().from(studyPlans).where(eq(studyPlans.studentId, studentId));
  if (!plan) return;
  const dayStart = new Date(now.getTime() - 24 * 3_600_000);
  const due = await db.query.learningActivities.findMany({
    where: (a, { and: andOp, eq: eqOp }) => andOp(eqOp(a.studentId, studentId), eqOp(a.planId, plan.id), eqOp(a.planVersion, plan.currentVersion), eqOp(a.status, "planned")),
  });
  const dueToday = due.filter((a) => a.scheduledStart <= now && a.scheduledStart > dayStart);

  for (const activity of dueToday) {
    const attends = simulateAttendance(sim, rng);
    if (!attends) {
      await db.update(learningActivities).set({ status: "missed", missedAt: now }).where(eq(learningActivities.id, activity.id));
      continue;
    }

    const purpose = purposeFor(activity.action);
    if (purpose) {
      try {
        const composed = await composeAssessment({ student_id: studentId, subtopic_id: activity.subtopicId, purpose, count: 8 });
        const qRows = await db.query.questions.findMany({ where: (q, { inArray }) => inArray(q.id, composed.question_ids) });
        const byId = new Map(qRows.map((q) => [q.id, q]));
        const answers = composed.question_ids.map((qId) => {
          const q = byId.get(qId);
          const difficulty = q?.difficulty ?? 3;
          const correctIndex = q?.correctIndex ?? 0;
          const correct = simulateAnswer(sim, activity.subtopicId, difficulty, rng);
          return { question_id: qId, chosen_index: correct ? correctIndex : (correctIndex + 1) % 4 };
        });
        const result = await submitAnswers({ assessment_id: composed.assessment_id, answers });
        samples.push({ subtopic_id: activity.subtopicId, predicted_score: composed.predicted_score, actual_score: result.score, day: dayIndex });
      } catch {
        // A degraded qbank (chaos mode) can make composition fail — treat as attended but
        // untested, matching how a real student experiencing a broken tool would just study.
      }
    } else if (activity.action === "LEARN" || activity.action === "PRACTICE" || activity.action === "REVISION") {
      applyLearningGain(sim, activity.subtopicId, activity.durationMin / 60, dayIndex);
    }
    await db.update(learningActivities).set({ status: "completed", completedAt: now, actualDurationMin: activity.durationMin }).where(eq(learningActivities.id, activity.id));
  }
}

export async function runEvalStudent(opts: { runLabel: string; index: number; subjectId: string; profile: EvalProfile; days: number; seed: number }): Promise<StudentResult> {
  const { student: sim, goalId } = await createEvalStudent(opts);
  const rng = mulberry32(seedFrom(opts.seed, opts.index, "answers"));
  const assessments: AssessmentSample[] = [];
  const ticks: TickSample[] = [];

  for (let day = 0; day < opts.days; day++) {
    const before = await getSimNow(sim.id);
    if (sim.availabilityShock && day === sim.availabilityShock.day) {
      await applyAvailabilityShock(sim.id, sim.availabilityShock.new_daily_hours, before);
    }
    await advanceSimClock(sim.id, 24);
    const now = await getSimNow(sim.id);

    const started = Date.now();
    const result = await tick(sim.id);
    const latencyMs = Date.now() - started;

    let route: string | null = null;
    let repairRounds = 0;
    if (result.scope !== "NONE") {
      const [plan] = await db.select().from(studyPlans).where(eq(studyPlans.studentId, sim.id));
      if (plan) {
        const [version] = await db.select().from(planVersions).where(and(eq(planVersions.planId, plan.id), eq(planVersions.version, plan.currentVersion)));
        if (version) {
          repairRounds = version.repairRounds;
          route = (version.validationReport as { route?: string } | null)?.route ?? null;
        }
      }
    }
    ticks.push({ day, scope: result.scope, route, repair_rounds: repairRounds, latency_ms: latencyMs, outcome: result.outcome ?? null });

    await processActivitiesForToday(sim, sim.id, now, day, rng, assessments);
    applyDailyForgetting(sim);
  }

  const masteryRows = await db.select().from(subtopicMastery).where(eq(subtopicMastery.studentId, sim.id));
  const finalMuBySubtopic = Object.fromEntries(masteryRows.map((m) => [m.subtopicId, Number(m.mu)]));
  const [goalRow] = await db.select({ targetMastery: learningGoals.targetMastery }).from(learningGoals).where(eq(learningGoals.id, goalId));
  const targetMastery = (goalRow?.targetMastery as Record<string, number>) ?? {};
  const goalAchieved = Object.entries(targetMastery).every(([id, target]) => (finalMuBySubtopic[id] ?? 0) >= target * 0.95);

  return { studentId: sim.id, profile: sim.profile, assessments, ticks, finalMuBySubtopic, finalTrueMastery: sim.trueMastery, goalAchieved };
}
