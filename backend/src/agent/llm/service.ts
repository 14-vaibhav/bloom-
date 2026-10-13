import { z, type ZodType } from "zod";
import { db } from "../../db/client.js";
import { agentEvents } from "../../db/schema.js";
import { publishAgentEvent } from "../../lib/eventBus.js";
import { checkBreaker, recordSuccess, recordTransientFailure } from "../../tools/breaker.js";
import { classifyError } from "../../tools/errors.js";
import type { AgentContext } from "../../tools/context.js";
import { cacheKey, readCache, writeCache } from "./cache.js";
import { loadPrompt } from "./prompt.js";
import { getProvider } from "./provider.js";
import type { LLMAgentName, LLMResult } from "./types.js";

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1] : text;
}

function enabled(): boolean {
  return process.env.LLM_ENABLED !== "false";
}

async function event(ctx: AgentContext, message: string, payload: Record<string, unknown>, latencyMs: number): Promise<void> {
  const [row] = await db.insert(agentEvents).values({
    runId: ctx.runId, studentId: ctx.studentId, seq: ctx.nextSeq(), phase: ctx.phase, eventType: "llm_call", toolName: "llm",
    message, payload, latencyMs,
  }).returning();
  publishAgentEvent(row);
}

/** Calls are cache-first, strict JSON-only, and have a deterministic fallback.
 * Post-validation is intentionally performed by the specialist after this
 * function returns; it never retries semantic rejection. */
export async function structuredCompletion<T>(opts: {
  ctx: AgentContext;
  agent: Exclude<LLMAgentName, "summary">;
  input: unknown;
  schema: ZodType<T>;
  fallback: T;
  model: string;
  maxTokens: number;
}): Promise<LLMResult<T>> {
  const started = Date.now();
  const fallback = async (reason: string): Promise<LLMResult<T>> => {
    const latencyMs = Date.now() - started;
    await event(opts.ctx, `${opts.agent}: ${reason}; deterministic fallback used.`, { agent: opts.agent, cache_hit: false, fallback_used: true, ok: false }, latencyMs);
    return { value: opts.fallback, source: "fallback", latencyMs, inputTokens: 0, outputTokens: 0, fallbackUsed: true };
  };
  if (!enabled()) return fallback("LLM disabled");
  const prompt = await loadPrompt(opts.agent);
  const key = cacheKey(opts.agent, prompt.version, opts.input);
  const cached = await readCache<T>(key);
  if (cached) {
    const parsed = opts.schema.safeParse(cached.response);
    if (parsed.success) {
      const latencyMs = Date.now() - started;
      await event(opts.ctx, `${opts.agent}: cache hit.`, { agent: opts.agent, cache_hit: true, fallback_used: false, ok: true, prompt_version: prompt.version }, latencyMs);
      return { value: parsed.data, source: "cache", latencyMs, inputTokens: cached.inputTokens, outputTokens: cached.outputTokens, fallbackUsed: false };
    }
  }
  if (await checkBreaker("llm", opts.ctx.clock()) === "open") return fallback("LLM circuit open");
  const provider = getProvider();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await provider.complete({ model: opts.model, system: prompt.system, user: JSON.stringify(opts.input), maxTokens: opts.maxTokens, temperature: 0, timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 8000) });
      let json: unknown;
      try {
        json = JSON.parse(stripFences(response.text));
      } catch {
        if (attempt === 0) continue;
        return fallback("malformed JSON response");
      }
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        // Malformed JSON/schema may be transient provider formatting; one retry is allowed.
        if (attempt === 0) continue;
        return fallback("malformed LLM response");
      }
      await recordSuccess("llm", opts.ctx.clock());
      await writeCache({ key, agent: opts.agent, promptVersion: prompt.version, response: parsed.data, inputTokens: response.inputTokens, outputTokens: response.outputTokens });
      const latencyMs = Date.now() - started;
      await event(opts.ctx, `${opts.agent}: completed.`, { agent: opts.agent, model: opts.model, cache_hit: false, fallback_used: false, ok: true, prompt_version: prompt.version, input_tokens: response.inputTokens, output_tokens: response.outputTokens }, latencyMs);
      return { value: parsed.data, source: "llm", latencyMs, inputTokens: response.inputTokens, outputTokens: response.outputTokens, fallbackUsed: false };
    } catch (error) {
      if (classifyError(error) !== "transient" || attempt === 1) {
        if (classifyError(error) === "transient") await recordTransientFailure("llm", opts.ctx.clock(), error instanceof Error ? error.message : String(error));
        return fallback(error instanceof Error ? error.message : "LLM failure");
      }
    }
  }
  return fallback("LLM completion exhausted retries");
}
