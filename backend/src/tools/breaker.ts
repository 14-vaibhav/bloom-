/**
 * Circuit breaker, persisted in tool_health so it survives a restart
 * (bloom-phase2-brief.md §7.3). Only transient failures ever reach this —
 * permanent and validation errors must never trip it (a dead resource URL
 * must not take all of RAG offline).
 *
 * "60 simulated seconds" is measured against an injectable clock, not
 * wall-clock time, so tests (and later, the demo's simulated clock) can
 * advance it without a real sleep.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { toolHealth } from "../db/schema.js";
import type { ToolBucket } from "./errors.js";

export const BREAKER_THRESHOLD = 3;
export const OPEN_DURATION_MS = 60_000;

export type BreakerDecision = "closed" | "half_open_probe" | "open";

type ToolHealthRow = typeof toolHealth.$inferSelect;

async function ensureRow(tool: ToolBucket): Promise<ToolHealthRow> {
  const [existing] = await db.select().from(toolHealth).where(eq(toolHealth.toolName, tool));
  if (existing) return existing;
  await db.insert(toolHealth).values({ toolName: tool }).onConflictDoNothing();
  const [row] = await db.select().from(toolHealth).where(eq(toolHealth.toolName, tool));
  return row;
}

export async function checkBreaker(tool: ToolBucket, now: Date): Promise<BreakerDecision> {
  const row = await ensureRow(tool);
  if (row.state === "closed") return "closed";

  if (row.state === "open") {
    const openedAt = row.openedAt ?? now;
    if (now.getTime() - openedAt.getTime() >= OPEN_DURATION_MS) {
      await db.update(toolHealth).set({ state: "half_open" }).where(eq(toolHealth.toolName, tool));
      return "half_open_probe";
    }
    return "open";
  }

  // half_open: best-effort single probe. Under real concurrency two callers could both
  // see half_open at once; acceptable for Bloom's single-student demo scale.
  return "half_open_probe";
}

/** Returns true if this success closed a breaker that was open/half_open — i.e. a recovery. */
export async function recordSuccess(tool: ToolBucket, now: Date): Promise<boolean> {
  const row = await ensureRow(tool);
  const recovered = row.state !== "closed";
  await db
    .update(toolHealth)
    .set({ state: "closed", consecutiveFailures: 0, lastSuccessAt: now })
    .where(eq(toolHealth.toolName, tool));
  return recovered;
}

export async function recordTransientFailure(
  tool: ToolBucket,
  now: Date,
  errorMessage: string,
): Promise<{ opened: boolean; reopenedFromHalfOpen: boolean }> {
  const row = await ensureRow(tool);
  const failures = row.consecutiveFailures + 1;
  const wasHalfOpen = row.state === "half_open";
  const wasClosed = row.state === "closed";
  const shouldOpen = wasHalfOpen || (wasClosed && failures >= BREAKER_THRESHOLD);

  await db
    .update(toolHealth)
    .set({
      consecutiveFailures: failures,
      lastError: errorMessage.slice(0, 500),
      state: shouldOpen ? "open" : row.state,
      openedAt: shouldOpen ? now : row.openedAt,
    })
    .where(eq(toolHealth.toolName, tool));

  return { opened: shouldOpen, reopenedFromHalfOpen: wasHalfOpen && shouldOpen };
}

export async function getToolHealth(tool: ToolBucket): Promise<ToolHealthRow> {
  return ensureRow(tool);
}
