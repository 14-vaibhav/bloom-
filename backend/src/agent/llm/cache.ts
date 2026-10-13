import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { llmCache } from "../../db/schema.js";
import type { LLMAgentName } from "./types.js";

/** Stable JSON for cache keys: object keys sorted recursively; arrays preserve
 * their meaningful order. JSON.stringify supplies stable number formatting. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function cacheKey(agent: LLMAgentName, promptVersion: string, input: unknown): string {
  return createHash("sha256").update(`${agent}:${promptVersion}:${canonicalJson(input)}`).digest("hex");
}

export async function readCache<T>(key: string): Promise<{ response: T; inputTokens: number; outputTokens: number } | null> {
  if (process.env.LLM_CACHE_ENABLED === "false") return null;
  const [row] = await db.select().from(llmCache).where(eq(llmCache.key, key));
  if (!row) return null;
  await db.update(llmCache).set({ hits: sql`${llmCache.hits} + 1` }).where(eq(llmCache.key, key));
  return { response: row.response as T, inputTokens: row.inputTokens, outputTokens: row.outputTokens };
}

export async function writeCache(opts: { key: string; agent: LLMAgentName; promptVersion: string; response: unknown; inputTokens: number; outputTokens: number }): Promise<void> {
  if (process.env.LLM_CACHE_ENABLED === "false") return;
  await db.insert(llmCache).values(opts).onConflictDoNothing();
}
