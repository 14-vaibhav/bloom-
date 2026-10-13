/**
 * Phase 2's own demo-to-ourselves (bloom-phase2-brief.md §11): call three
 * different tools through the real dispatcher, then read agent_events back
 * in order. If that output doesn't tell a clear story, the `message` strings
 * need work before Phase 8 turns them into the Agent Activity feed.
 *
 * Not part of the test suite — run manually: `npm run tools:smoke`
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { agentEvents, students } from "../db/schema.js";
import { callTool } from "../tools/dispatcher.js";
import { createAgentContext } from "../tools/context.js";

async function main() {
  const [student] = await db.select().from(students).where(eq(students.email, "demo@bloom.local"));
  if (!student) throw new Error("No seeded demo student found — run `npm run seed` first.");

  const ctx = await createAgentContext({ studentId: student.id, trigger: "MANUAL", phase: "retrieve" });

  await callTool(ctx, "performance.get_subtopic_performance", {
    student_id: student.id,
    subtopic_ids: ["arr_traversal", "arr_binary_search"],
  });

  await callTool(ctx, "rag.search_learning_resources", {
    subtopic_id: "arr_binary_search",
    target_difficulty: 2,
    max_duration_min: 45,
    exclude_ids: [],
    k: 5,
  });

  await callTool(ctx, "calendar.get_available_slots", {
    student_id: student.id,
    from: student.simNow.toISOString(),
    to: new Date(student.simNow.getTime() + 3 * 86400000).toISOString(),
    min_slot_min: 15,
  });

  const rows = await db.select().from(agentEvents).where(eq(agentEvents.runId, ctx.runId)).orderBy(agentEvents.seq);

  console.log(`\nrun_id: ${ctx.runId}\n`);
  for (const r of rows) {
    console.log(`[${String(r.seq).padStart(2, "0")}] ${r.phase.padEnd(14)} ${(r.toolName ?? "").padEnd(11)} ${r.message}`);
  }
  console.log(`\n${rows.length} agent_events rows across 3 tool calls.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error("tools-smoke FAILED:", err.message ?? err);
  await pool.end();
  process.exit(1);
});
