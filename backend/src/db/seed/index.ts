import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../client.js";
import { seedDomain } from "./subjects.js";
import { seedResources } from "./resources.js";
import { seedQuestions } from "./questions.js";
import { seedStudent } from "./student.js";
import { validateEvalProfiles, seedToolHealth } from "./evalProfiles.js";

const TABLES_IN_TRUNCATE_ORDER = [
  "agent_events", "agent_runs",
  "learning_activities", "plan_versions", "study_plans",
  "assessment_results", "assessments", "question_attempts", "question_state",
  "calendar_events", "student_constraints", "learning_goals",
  "mastery_observations", "subtopic_mastery",
  "resource_feedback",
  "questions", "resources",
  "concepts", "subtopic_prerequisites", "subtopics",
  "topic_prerequisites", "topics", "subjects",
  "students",
  "eval_students", "eval_runs",
  "tool_health", "daily_summaries", "idempotency_keys",
];

async function reset() {
  console.log("Resetting database (truncate all seedable tables)...");
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES_IN_TRUNCATE_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE;`));
}

async function main() {
  const shouldReset = process.argv.includes("--reset");
  if (shouldReset) {
    await reset();
  }

  console.log("\n[1/8] Domain: subjects → topics → subtopics → concepts → prerequisites");
  await seedDomain();

  console.log("\n[2/8] Resources (verifying every URL live before insert)");
  await seedResources();

  console.log("\n[3/8] Questions (from generate-questions.ts output, if present)");
  await seedQuestions();

  console.log("\n[4/8] Student, constraints, calendar");
  await seedStudent();

  console.log("\n[5/8] Eval profiles (validated, not yet persisted — Phase 9 concern)");
  await validateEvalProfiles();

  console.log("\n[6/8] tool_health (one closed row per tool)");
  await seedToolHealth();

  console.log("\nSeed complete.");
  await pool.end();
}

main().catch(async (err) => {
  console.error("\nSeed FAILED:", err.message ?? err);
  await pool.end();
  process.exit(1);
});
