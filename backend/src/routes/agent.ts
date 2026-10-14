/**
 * Agent routes (bloom-phase8-brief §A2/A3): trigger a run, evaluate the tick
 * for all active students, page the audit log, and stream it live over SSE.
 */

import { Router } from "express";
import { desc, eq, gt, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { agentEvents, agentRuns, students } from "../db/schema.js";
import { tick } from "../agent/orchestrator.js";
import { subscribeAgentEvents } from "../lib/eventBus.js";
import { asyncRoute, badRequest, ok, parseBody, parseQuery } from "../lib/http.js";
import { getToolHealth } from "../tools/breaker.js";
import type { ToolBucket } from "../tools/errors.js";
import { assertOwns, authRequired } from "../lib/auth.js";

export const agentRouter = Router();

const TOOL_BUCKETS: ToolBucket[] = ["performance", "rag", "calendar", "qbank", "state", "llm"];
const BACKLOG_CAP = 200;
// Overridable so sse.test.ts can assert the heartbeat fires without a real 15s wait.
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS ?? 15_000);

agentRouter.post("/agent/run", asyncRoute(async (req, res) => {
  const body = parseBody(z.object({ student_id: z.string().uuid() }), req.body);
  assertOwns(req, body.student_id);
  const result = await tick(body.student_id);
  ok(res, result);
}));

agentRouter.post("/agent/tick", asyncRoute(async (req, res) => {
  // Evaluates every active student in one sweep — the same code path the
  // 30-second scheduler in agent/scheduler.ts calls.
  const everyone = await db.selectDistinct({ id: students.id }).from(students);
  // With auth enforced a caller can only sweep their own student, never everyone's.
  const active = authRequired() ? everyone.filter((s) => s.id === req.auth?.studentId) : everyone;
  const results = await Promise.all(active.map(async (s) => ({ student_id: s.id, ...(await tick(s.id)) })));
  ok(res, { ran: results.length, results });
}));

agentRouter.get("/agent/runs", asyncRoute(async (req, res) => {
  const parsed = parseQuery(z.object({ student_id: z.string().uuid().optional() }), req.query);
  const query = { student_id: authRequired() ? req.auth?.studentId ?? parsed.student_id : parsed.student_id };
  if (query.student_id) assertOwns(req, query.student_id);
  const rows = query.student_id
    ? await db.select().from(agentRuns).where(eq(agentRuns.studentId, query.student_id)).orderBy(desc(agentRuns.startedAt)).limit(100)
    : await db.select().from(agentRuns).orderBy(desc(agentRuns.startedAt)).limit(100);
  ok(res, rows.map((r) => ({
    run_id: r.id, student_id: r.studentId, trigger: r.trigger, scope: r.scope, outcome: r.outcome, status: r.status,
    degraded_tools: r.degradedTools, tool_call_count: r.toolCallCount, llm_call_count: r.llmCallCount,
    total_latency_ms: r.totalLatencyMs, new_plan_version: r.newPlanVersion, started_at: r.startedAt.toISOString(),
    ended_at: r.endedAt?.toISOString() ?? null,
  })));
}));

agentRouter.get("/tool-health", asyncRoute(async (_req, res) => {
  const rows = await Promise.all(TOOL_BUCKETS.map((tool) => getToolHealth(tool)));
  ok(res, rows.map((r) => ({
    tool: r.toolName, state: r.state, consecutive_failures: r.consecutiveFailures,
    opened_at: r.openedAt?.toISOString() ?? null, last_error: r.lastError,
    last_success_at: r.lastSuccessAt?.toISOString() ?? null,
  })));
}));

agentRouter.get("/students/:id/events", asyncRoute(async (req, res) => {
  const query = parseQuery(z.object({ since: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), run_id: z.string().uuid().optional() }), req.query);
  if (query.run_id) {
    const rows = await db.select().from(agentEvents).where(and(eq(agentEvents.studentId, req.params.id), eq(agentEvents.runId, query.run_id))).orderBy(agentEvents.id);
    ok(res, rows.map(serializeEvent));
    return;
  }
  const hasSince = query.since !== undefined;
  const rows = hasSince
    ? await db.select().from(agentEvents).where(and(eq(agentEvents.studentId, req.params.id), gt(agentEvents.id, query.since as number))).orderBy(agentEvents.id).limit(query.limit)
    : await db.select().from(agentEvents).where(eq(agentEvents.studentId, req.params.id)).orderBy(desc(agentEvents.id)).limit(query.limit);
  ok(res, (hasSince ? rows : rows.reverse()).map(serializeEvent));
}));

function serializeEvent(row: typeof agentEvents.$inferSelect) {
  return {
    id: row.id, run_id: row.runId, seq: row.seq, phase: row.phase, event_type: row.eventType,
    tool_name: row.toolName, message: row.message, payload: row.payload, error_class: row.errorClass,
    retry_attempt: row.retryAttempt, latency_ms: row.latencyMs, created_at: row.createdAt.toISOString(),
  };
}

/**
 * SSE feed (bloom-phase8-brief §A3). `Last-Event-ID` (header, or `?lastEventId=`
 * for EventSource polyfills that can't set headers) replays only newer rows,
 * capped at 200 so a reconnect after an eval run doesn't dump thousands of
 * events into the browser. A 15s heartbeat comment keeps proxies from killing
 * the connection as idle.
 */
agentRouter.get("/students/:id/stream", asyncRoute(async (req, res) => {
  const studentId = req.params.id;
  const lastEventIdRaw = req.header("Last-Event-ID") ?? (req.query.lastEventId as string | undefined);
  const lastEventId = lastEventIdRaw ? Number(lastEventIdRaw) : undefined;
  if (lastEventIdRaw !== undefined && (lastEventId === undefined || Number.isNaN(lastEventId))) {
    throw badRequest("Last-Event-ID must be numeric", "Last-Event-ID");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (row: typeof agentEvents.$inferSelect) => {
    res.write(`id: ${row.id}\nevent: agent_event\ndata: ${JSON.stringify(serializeEvent(row))}\n\n`);
  };

  const backlog = lastEventId !== undefined
    ? await db.select().from(agentEvents).where(and(eq(agentEvents.studentId, studentId), gt(agentEvents.id, lastEventId as number))).orderBy(agentEvents.id).limit(BACKLOG_CAP)
    : [];
  for (const row of backlog) send(row);

  const unsubscribe = subscribeAgentEvents(studentId, send);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}));
