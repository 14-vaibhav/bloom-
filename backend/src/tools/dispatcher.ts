/**
 * callTool() — the only door into a tool. Every call, in order (bloom-phase2-brief.md §5):
 *   1. check the breaker — fail fast or fall back, never call through an open circuit
 *   2. validate input — permanent, never retried
 *   3/4. execute with timeout, retrying transient errors once
 *   5. validate output — a schema drift is our bug, not the dependency's
 *   6. update tool_health
 *   7. write exactly one agent_events row for the call, plus a separate
 *      state_change row on any breaker transition (open, or recovered)
 *
 * The retry/breaker/logging engine (dispatchWithResilience) is factored out
 * from the schema lookup so resilience.test.ts can drive it with a
 * fault-injecting fake operation instead of a real tool.
 *
 * If any code path reaches a tool without going through here, it is invisible
 * in the event log — enforce that in review, not just in code.
 */

import { db } from "../db/client.js";
import { agentEvents } from "../db/schema.js";
import { publishAgentEvent } from "../lib/eventBus.js";
import { toolSchemas, type ToolInput, type ToolName, type ToolOutput } from "./schemas.js";
import type { AgentContext, AgentPhase } from "./context.js";
import { registry } from "./registry.js";
import { getDegradedFallback } from "./degraded.js";
import { checkBreaker, recordSuccess, recordTransientFailure, BREAKER_THRESHOLD } from "./breaker.js";
import { classifyError, TimeoutError, ToolUnavailableError, ValidationError } from "./errors.js";
import type { ToolBucket } from "./errors.js";

export const TIMEOUT_MS: Record<ToolBucket, number> = {
  performance: 1000,
  calendar: 1000,
  qbank: 1000,
  state: 1000,
  rag: 3000,
  kb: 4000,
  llm: Number(process.env.LLM_TIMEOUT_MS ?? 8000),
};

const MAX_RETRIES = 1; // 2 attempts total, transient errors only
const BACKOFF_MS = [200, 600];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function truncate(value: unknown, maxChars = 2048): unknown {
  const json = JSON.stringify(value) ?? "null";
  return json.length > maxChars ? `${json.slice(0, maxChars)}...(truncated)` : value;
}

function summarize(output: unknown): unknown {
  if (Array.isArray(output)) {
    const sample = output.slice(0, 3).map((item) => {
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        return o.id ?? o.question_id ?? o.event_id ?? o.subtopic_id ?? o.assessment_id ?? "?";
      }
      return item;
    });
    return { count: output.length, sample };
  }
  const json = JSON.stringify(output) ?? "null";
  return json.length > 300 ? `${json.slice(0, 300)}...(truncated)` : output;
}

function buildMessage(operation: string, input: unknown, output: unknown, notices: string[]): string {
  const inputStr = JSON.stringify(input).slice(0, 120);
  const countPart = Array.isArray(output) ? `→ ${output.length} result${output.length === 1 ? "" : "s"}` : "→ ok";
  const base = `${operation}(${inputStr}) ${countPart}`;
  return notices.length > 0 ? `${base}. ${notices.join(" ")}` : base;
}

async function logEvent(
  ctx: AgentContext,
  opts: {
    toolName: ToolBucket;
    message: string;
    eventType?: "tool_call" | "state_change" | "notice";
    errorClass?: string | null;
    retryAttempt?: number;
    latencyMs?: number | null;
    payload?: unknown;
    phase?: AgentPhase;
  },
): Promise<void> {
  if (ctx.untracked) return; // outside the agent loop (tutor): the caller keeps its own trace
  const [row] = await db.insert(agentEvents).values({
    runId: ctx.runId,
    studentId: ctx.studentId,
    seq: ctx.nextSeq(),
    phase: opts.phase ?? ctx.phase,
    eventType: opts.eventType ?? "tool_call",
    toolName: opts.toolName,
    message: opts.message.slice(0, 2000),
    payload: opts.payload as object | undefined,
    errorClass: opts.errorClass ?? null,
    retryAttempt: opts.retryAttempt ?? 0,
    latencyMs: opts.latencyMs ?? null,
  }).returning();
  publishAgentEvent(row);
}

export type OutputValidation<T> = { success: true; data: T } | { success: false; error: unknown };

/**
 * The resilience engine: breaker check → degraded fallback → timeout+retry →
 * output validation → tool_health update → exactly one agent_events row (plus
 * a separate row on any breaker state transition). Exported so
 * resilience.test.ts can drive it with a fault-injecting fake operation
 * instead of a real tool — the mechanism under test is identical either way.
 */
export async function dispatchWithResilience<T>(
  ctx: AgentContext,
  bucket: ToolBucket,
  operation: string,
  input: unknown,
  run: (input: unknown, ctx: AgentContext) => Promise<{ output: T; notices?: string[] }>,
  validateOutput: (output: unknown) => OutputValidation<T> = (o) => ({ success: true, data: o as T }),
  timeoutMs: number = TIMEOUT_MS[bucket],
): Promise<T> {
  const now = ctx.clock();

  // ── 1. breaker check ────────────────────────────────────────────
  const decision = await checkBreaker(bucket, now);
  if (decision === "open") {
    let fallback;
    try {
      fallback = await getDegradedFallback(bucket, operation, input);
    } catch (err) {
      await logEvent(ctx, {
        toolName: bucket,
        message: (err as Error).message,
        errorClass: (err as Error).name,
        payload: { operation, ok: false },
      });
      throw err;
    }

    if (fallback) {
      await logEvent(ctx, {
        toolName: bucket,
        message: fallback.message,
        payload: { operation, ok: true, degraded: true, signal: fallback.signal },
      });
      return fallback.data as T;
    }

    const unavailable = new ToolUnavailableError(bucket, `${bucket} circuit open — no degraded fallback for ${operation}`);
    await logEvent(ctx, {
      toolName: bucket,
      message: unavailable.message,
      errorClass: "unavailable",
      payload: { operation, ok: false },
    });
    throw unavailable;
  }

  // ── 3/4. execute with timeout + retry (transient only) ─────────
  const start = Date.now();
  let attempt = 0;

  while (true) {
    try {
      const result = await withTimeout(run(input, ctx), timeoutMs, `${operation} timed out after ${timeoutMs}ms`);

      // ── 5. validate output ──────────────────────────────────────
      const validated = validateOutput(result.output);
      if (!validated.success) {
        throw new ValidationError(`Invalid output from ${operation}: ${String(validated.error)}`);
      }

      const latencyMs = Date.now() - start;
      const recovered = await recordSuccess(bucket, ctx.clock());

      await logEvent(ctx, {
        toolName: bucket,
        message: buildMessage(operation, input, validated.data, result.notices ?? []),
        retryAttempt: attempt,
        latencyMs,
        payload: {
          operation,
          input: truncate(input),
          output_summary: summarize(validated.data),
          ok: true,
          degraded: false,
          notices: result.notices ?? [],
        },
      });

      if (recovered) {
        await logEvent(ctx, {
          toolName: bucket,
          eventType: "state_change",
          message: `${bucket} circuit closed — tool recovered.`,
          payload: { operation },
        });
      }

      return validated.data;
    } catch (err) {
      const errorClass = classifyError(err);
      const latencyMs = Date.now() - start;

      if (errorClass === "validation") {
        await logEvent(ctx, {
          toolName: bucket,
          message: (err as Error).message.slice(0, 300),
          errorClass: "validation",
          retryAttempt: attempt,
          latencyMs,
          payload: { operation, input: truncate(input), ok: false },
        });
        throw err;
      }

      if (errorClass === "permanent") {
        await logEvent(ctx, {
          toolName: bucket,
          message: (err as Error).message.slice(0, 300),
          errorClass: "permanent",
          retryAttempt: attempt,
          latencyMs,
          payload: { operation, input: truncate(input), ok: false },
        });
        throw err;
      }

      // transient
      if (attempt < MAX_RETRIES) {
        attempt += 1;
        const backoff = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
        const jitter = backoff * (0.8 + Math.random() * 0.4);
        await sleep(jitter);
        continue;
      }

      // retries exhausted — terminal failure, counts toward the breaker
      const { opened, reopenedFromHalfOpen } = await recordTransientFailure(bucket, ctx.clock(), (err as Error).message);

      await logEvent(ctx, {
        toolName: bucket,
        message: (err as Error).message.slice(0, 300),
        errorClass: "transient",
        retryAttempt: attempt,
        latencyMs,
        payload: { operation, input: truncate(input), ok: false },
      });

      if (opened) {
        await logEvent(ctx, {
          toolName: bucket,
          eventType: "state_change",
          message: reopenedFromHalfOpen
            ? `${bucket} circuit reopened — probe failed.`
            : `${bucket} circuit opened after ${BREAKER_THRESHOLD} consecutive failures — entering degraded mode.`,
          payload: { operation },
        });
      }

      throw err;
    }
  }
}

export async function callTool<T extends ToolName>(
  ctx: AgentContext,
  name: T,
  input: ToolInput<T>,
): Promise<ToolOutput<T>> {
  const schema = toolSchemas[name];
  const bucket = schema.bucket as ToolBucket;
  const operation = name.split(".")[1];

  const parsedInput = schema.input.safeParse(input);
  if (!parsedInput.success) {
    const err = new ValidationError(`Invalid input for ${name}: ${parsedInput.error.message}`);
    await logEvent(ctx, {
      toolName: bucket,
      message: err.message.slice(0, 300),
      errorClass: "validation",
      payload: { operation, input: truncate(input), ok: false },
    });
    throw err;
  }

  const handler = registry[name] as (i: ToolInput<T>, c: AgentContext) => Promise<{ output: unknown; notices?: string[] }>;

  return dispatchWithResilience<ToolOutput<T>>(
    ctx,
    bucket,
    operation,
    parsedInput.data,
    async (i, c) => {
      const result = await handler(i as ToolInput<T>, c);
      return result as { output: ToolOutput<T>; notices?: string[] };
    },
    (output) => {
      const parsed = schema.output.safeParse(output);
      return parsed.success ? { success: true, data: parsed.data as ToolOutput<T> } : { success: false, error: parsed.error };
    },
  );
}
