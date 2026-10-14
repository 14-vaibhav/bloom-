/**
 * npm run eval — runs the Phase 9 learner-simulation harness and writes eval-results.json at the repo
 * root, which GET /api/eval/latest serves to the Eval screen.
 *
 *   npm run eval -- [--per-profile 2] [--days 21] [--subject dsa] [--seed 42]
 *
 * Every simulated student is a real row in `students` (email `eval-<run>-…@bloom.sim`); the harness drives
 * the real tick(), composeAssessment() and submitAnswers(). Needs a seeded database with questions for the
 * subject. Nothing is invented here: the numbers are computed from what the harness measured.
 */
import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { db, pool } from "../db/client.js";
import { evalRuns, evalStudents } from "../db/schema.js";
import { llmEnabled } from "../agent/llm/kb.js";
import { runEvalStudent, type StudentResult } from "../eval/harness.js";
import type { EvalProfile } from "../eval/simStudent.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PROFILES_PATH = path.resolve(import.meta.dirname, "../db/seed/data/eval-profiles.json");
const OUT_PATH = path.join(ROOT, "eval-results.json");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Ten equal-width bins over predicted score: the mean predicted vs mean actual score in each. */
function calibration(results: StudentResult[]) {
  const samples = results.flatMap((r) => r.assessments);
  return Array.from({ length: 10 }, (_, i) => {
    const bin = samples.filter((s) => Math.min(9, Math.floor(s.predicted_score * 10)) === i);
    return { decile: i + 1, predicted_mean: mean(bin.map((s) => s.predicted_score)), actual_mean: mean(bin.map((s) => s.actual_score)), count: bin.length };
  }).filter((b) => b.count > 0);
}

function summarise(results: StudentResult[]) {
  const ticks = results.flatMap((r) => r.ticks).filter((t) => t.scope !== "NONE");
  const samples = results.flatMap((r) => r.assessments);
  return {
    students: results.length,
    goal_achieved_rate: results.length ? results.filter((r) => r.goalAchieved).length / results.length : 0,
    interventions: ticks.length,
    patch_share: ticks.length ? ticks.filter((t) => t.scope === "PATCH").length / ticks.length : 0,
    full_replan_share: ticks.length ? ticks.filter((t) => t.scope === "FULL").length / ticks.length : 0,
    mean_repair_rounds: mean(ticks.map((t) => t.repair_rounds)),
    latency_p50_ms: percentile(ticks.map((t) => t.latency_ms), 50) ?? 0,
    latency_p95_ms: percentile(ticks.map((t) => t.latency_ms), 95) ?? 0,
    assessments: samples.length,
    prediction_mae: samples.length ? mean(samples.map((s) => Math.abs(s.predicted_score - s.actual_score))) : 0,
  };
}

async function main() {
  const perProfile = Number(arg("per-profile", "2"));
  const days = Number(arg("days", "21"));
  const subjectId = arg("subject", "dsa");
  const seed = Number(arg("seed", "42"));
  const profiles = JSON.parse(await readFile(PROFILES_PATH, "utf8")) as EvalProfile[];
  const runLabel = Date.now().toString(36);

  const results: StudentResult[] = [];
  for (const profile of profiles) {
    for (let i = 0; i < perProfile; i++) {
      const index = results.length;
      console.log(`  ${profile.name} #${i + 1}/${perProfile} (${days} simulated days)…`);
      results.push(await runEvalStudent({ runLabel, index, subjectId, profile, days, seed: seed + index }));
    }
  }

  const metrics = summarise(results);
  const perProfileMetrics = Object.fromEntries(profiles.map((p) => [p.name, summarise(results.filter((r) => r.profile === p.name))]));
  const report = {
    seed, llm_enabled: llmEnabled(), chaos_rate: 0, student_count: results.length, days,
    metrics, calibration: calibration(results), per_profile: perProfileMetrics,
  };

  const [run] = await db.insert(evalRuns).values({
    config: { per_profile: perProfile, days, subject_id: subjectId }, seed, llmEnabled: report.llm_enabled, chaosRate: "0", metrics,
  }).returning({ id: evalRuns.id });
  for (const r of results) {
    const profile = profiles.find((p) => p.name === r.profile);
    await db.insert(evalStudents).values({
      evalRunId: run.id, profile: r.profile, trueMastery: r.finalTrueMastery, trueLearnRate: String(profile?.true_learn_rate ?? 0),
      outcome: { goal_achieved: r.goalAchieved, final_mu: r.finalMuBySubtopic },
    });
  }

  await writeFile(OUT_PATH, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)} (${results.length} students, ${metrics.assessments} assessments).`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
