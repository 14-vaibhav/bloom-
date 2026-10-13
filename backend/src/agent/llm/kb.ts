/**
 * LLM access for the knowledge base (v4 §N1.2, §N4, §N6.1). Same providers, cache and
 * circuit breaker as structuredCompletion(), but with no AgentContext: ingestion and the
 * tutor run outside the agent loop and must not create agent_runs rows (§N3.2). Vision
 * calls hit the same cache keyed on the image hash, so re-ingesting costs nothing.
 */
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import { checkBreaker, recordSuccess, recordTransientFailure } from "../../tools/breaker.js";
import { classifyError } from "../../tools/errors.js";
import { systemClock } from "../../lib/clock.js";
import { cacheKey, readCache, writeCache } from "./cache.js";
import { loadPrompt } from "./prompt.js";
import { getProvider } from "./provider.js";
import type { LLMAgentName } from "./types.js";

export class KbLlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KbLlmUnavailableError";
  }
}

export function llmEnabled(): boolean {
  return process.env.LLM_ENABLED !== "false";
}

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1] : text;
}

export type KbCompletionOptions<T> = {
  agent: Extract<LLMAgentName, "slide_vision" | "tutor_answer" | "kb_question_gen">;
  /** Extra text appended to the system prompt (e.g. a validator failure report). Part of the cache key. */
  user: unknown;
  schema: ZodType<T>;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  images?: Array<{ mimeType: string; data: Buffer }>;
  /** Skip the breaker (offline scripts have no reason to share it). */
  offline?: boolean;
};

export function defaultModel(): string {
  const provider = process.env.LLM_PROVIDER ?? "gemini";
  return provider === "anthropic"
    ? process.env.ANTHROPIC_STRATEGIST_MODEL ?? "claude-sonnet-4-5"
    : process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
}

/** Throws KbLlmUnavailableError when disabled, breaker-open, or the provider fails after one retry. */
export async function kbComplete<T>(opts: KbCompletionOptions<T>): Promise<{ value: T; source: "llm" | "cache" }> {
  if (!llmEnabled()) throw new KbLlmUnavailableError("LLM disabled");
  const prompt = await loadPrompt(opts.agent);
  const imageHash = (opts.images ?? []).map((i) => createHash("sha256").update(i.data).digest("hex"));
  const model = opts.model ?? defaultModel();
  const key = cacheKey(opts.agent, prompt.version, { user: opts.user, imageHash, model });

  const cached = await readCache<T>(key);
  if (cached) {
    const parsed = opts.schema.safeParse(cached.response);
    if (parsed.success) return { value: parsed.data, source: "cache" };
  }

  if (!opts.offline && (await checkBreaker("llm", systemClock())) === "open") {
    throw new KbLlmUnavailableError("LLM circuit open");
  }

  const provider = getProvider();
  const timeoutMs = opts.timeoutMs ?? Number(process.env.KB_LLM_TIMEOUT_MS ?? 25000);
  let lastError: unknown = new Error("LLM failed");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await provider.complete({
        model,
        system: prompt.system,
        user: typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user),
        maxTokens: opts.maxTokens ?? 2048,
        temperature: 0,
        timeoutMs,
        images: opts.images?.map((i) => ({ mimeType: i.mimeType, base64: i.data.toString("base64") })),
      });
      let json: unknown;
      try {
        json = JSON.parse(stripFences(response.text));
      } catch {
        lastError = new Error("malformed JSON response");
        continue;
      }
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        lastError = new Error(`response failed schema: ${parsed.error.message.slice(0, 200)}`);
        continue;
      }
      if (!opts.offline) await recordSuccess("llm", systemClock());
      await writeCache({ key, agent: opts.agent, promptVersion: prompt.version, response: parsed.data, inputTokens: response.inputTokens, outputTokens: response.outputTokens });
      return { value: parsed.data, source: "llm" };
    } catch (error) {
      lastError = error;
      if (classifyError(error) !== "transient") break;
      if (attempt === 1 && !opts.offline) await recordTransientFailure("llm", systemClock(), error instanceof Error ? error.message : String(error));
    }
  }
  throw new KbLlmUnavailableError(lastError instanceof Error ? lastError.message : String(lastError));
}
