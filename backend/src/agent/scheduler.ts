/**
 * Tick scheduler (bloom-phase8-brief §A4). Calls the exact same `tick()`
 * every 30 real seconds that `POST /api/agent/tick` calls — a plain
 * setInterval rather than node-cron, since a fixed 30s cadence has no
 * schedule to express in cron syntax. Off by default in tests
 * (`TICK_ENABLED=false`) so scenario runs stay deterministic.
 */

import { db } from "../db/client.js";
import { students } from "../db/schema.js";
import { tick } from "./orchestrator.js";

const INTERVAL_MS = 30_000;
const runningStudents = new Set<string>();
let timer: NodeJS.Timeout | null = null;

async function runOneSweep(): Promise<void> {
  const active = await db.selectDistinct({ id: students.id }).from(students);
  for (const { id } of active) {
    if (runningStudents.has(id)) {
      console.log(`[scheduler] skip ${id}: a run is already in flight`);
      continue;
    }
    runningStudents.add(id);
    try {
      const result = await tick(id);
      // no_action rows are autonomy evidence, not noise — always logged (bloom-phase8-brief §A4).
      console.log(`[scheduler] tick ${id}: ${result.outcome ?? result.scope} — ${result.reason ?? ""}`);
    } catch (error) {
      console.error(`[scheduler] tick ${id} failed`, error);
    } finally {
      runningStudents.delete(id);
    }
  }
}

export function startScheduler(): void {
  if (process.env.TICK_ENABLED === "false") {
    console.log("[scheduler] TICK_ENABLED=false — scheduler not started.");
    return;
  }
  if (timer) return;
  timer = setInterval(() => { void runOneSweep(); }, INTERVAL_MS);
  console.log(`[scheduler] started, sweeping every ${INTERVAL_MS / 1000}s`);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
