/**
 * Simulated student ground truth (bloom-phase9-brief §B2). true_mastery and
 * true_learn_rate are the hidden state the agent never sees — it only ever
 * observes the outcome of an assessment or a completed activity, exactly
 * like a real student. Everything here is a pure function of (state, rng);
 * no wall-clock, no module-level mutable state, so a harness run is
 * reproducible from its seed alone.
 */

import type { Rng } from "./rng.js";
import { clamp, gaussian } from "./rng.js";

export type EvalProfileName = "fast_learner" | "average" | "chronic_misser" | "plateauer" | "availability_collapse";

export type EvalProfile = {
  name: EvalProfileName;
  true_learn_rate: number;
  attendance_probability: number;
  noise_sigma: number;
  true_mastery_base: number;
  learn_rate_collapse?: { day: number; factor: number };
  availability_shock?: { day: number; new_daily_hours: number };
};

export type SimStudent = {
  id: string; // real students.id — the harness creates a real row so the real agent runs against it
  profile: EvalProfileName;
  trueMastery: Record<string, number>; // hidden
  trueLearnRate: number; // hidden, mutated by learn_rate_collapse
  attendanceProbability: number;
  noiseSigma: number;
  learnRateCollapse?: { day: number; factor: number };
  availabilityShock?: { day: number; new_daily_hours: number };
};

export function initSimStudent(studentId: string, profile: EvalProfile, subtopicIds: string[], rng: Rng): SimStudent {
  const trueMastery: Record<string, number> = {};
  for (const id of subtopicIds) {
    trueMastery[id] = clamp(profile.true_mastery_base + gaussian(rng, 0, 0.08), 0.05, 0.95);
  }
  return {
    id: studentId, profile: profile.name, trueMastery, trueLearnRate: profile.true_learn_rate,
    attendanceProbability: profile.attendance_probability, noiseSigma: profile.noise_sigma,
    learnRateCollapse: profile.learn_rate_collapse, availabilityShock: profile.availability_shock,
  };
}

/** §B2 "Answering a question." */
export function simulateAnswer(sim: SimStudent, subtopicId: string, difficulty: number, rng: Rng): boolean {
  const mastery = sim.trueMastery[subtopicId] ?? 0.3;
  const pCorrect = clamp(mastery - (0.15 * (difficulty - 3)) / 2 + gaussian(rng, 0, sim.noiseSigma), 0.02, 0.98);
  return rng() < pCorrect;
}

/** §B2 "Completing an activity." Returns whether the student attended at all;
 * true_mastery is mutated in place only for LEARN/PRACTICE attendance. */
export function simulateAttendance(sim: SimStudent, rng: Rng): boolean {
  return rng() < sim.attendanceProbability;
}

export function applyLearningGain(sim: SimStudent, subtopicId: string, hours: number, dayIndex: number): void {
  const collapseActive = sim.learnRateCollapse && dayIndex >= sim.learnRateCollapse.day;
  const effectiveRate = collapseActive ? sim.trueLearnRate * sim.learnRateCollapse!.factor : sim.trueLearnRate;
  const current = sim.trueMastery[subtopicId] ?? 0.3;
  const gain = effectiveRate * hours * (1 - current); // diminishing returns
  sim.trueMastery[subtopicId] = clamp(current + gain, 0, 0.98);
}

/** §B2 "Forgetting" — applied once per simulated day, independent of the agent's own model. */
export function applyDailyForgetting(sim: SimStudent): void {
  for (const id of Object.keys(sim.trueMastery)) sim.trueMastery[id] *= 0.995;
}
