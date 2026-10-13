import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../client.js";
import { toolHealth } from "../schema.js";

const DATA_DIR = path.resolve(import.meta.dirname, "data");

// The 5 dispatcher tools plus "llm" — the Phase 7 specialist-call wrapper shares the same
// tool_health/circuit-breaker mechanism (src/agent/llm/service.ts), so it needs a row too.
const TOOLS = ["performance", "rag", "calendar", "qbank", "state", "kb", "llm"] as const;

/**
 * Eval profiles (bloom-architecture-plan.md §17.1) are pure content — no table of their own
 * to seed into yet (eval_runs/eval_students are populated by the Phase 9 harness, not seed).
 * This just validates the JSON shape now so a malformed file is caught in Phase 1, not Phase 9.
 */
export async function validateEvalProfiles() {
  const raw = await readFile(path.join(DATA_DIR, "eval-profiles.json"), "utf-8");
  const profiles = JSON.parse(raw) as Array<{ name: string; true_learn_rate: number; attendance_probability: number }>;
  if (profiles.length !== 5) {
    throw new Error(`Expected 5 eval profiles, found ${profiles.length}`);
  }
  console.log(`  eval profiles: ${profiles.length} validated (${profiles.map((p) => p.name).join(", ")})`);
  return profiles;
}

export async function seedToolHealth() {
  await db
    .insert(toolHealth)
    .values(TOOLS.map((toolName) => ({ toolName, state: "closed" as const })))
    .onConflictDoUpdate({ target: toolHealth.toolName, set: { state: sql`tool_health.state` } }); // no-op if present
  console.log(`  tool_health: ${TOOLS.length} rows (${TOOLS.join(", ")})`);
}
