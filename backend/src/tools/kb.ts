/**
 * Tool 6 — Knowledge Base (v4 §N3). Read-only over sources/source_chunks; goes through the same
 * dispatcher as the other five tools so it inherits retry, timeout, circuit breaker and logging.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { sourceChunks, sources } from "../db/schema.js";
import { getChunk as getChunkRow, searchCourseContent } from "../kb/retrieval.js";
import { PermanentError } from "./errors.js";
import type { HandlerResult } from "./registry.js";
import type { ToolInput, ToolOutput } from "./schemas.js";

export async function searchCourse(input: ToolInput<"kb.search_course_content">): Promise<HandlerResult<"kb.search_course_content">> {
  const { notices, ...result } = await searchCourseContent({
    query: input.query, subtopicIds: input.subtopic_ids, kinds: input.kinds, k: input.k,
  });
  return { output: result, notices };
}

export async function getChunk(input: ToolInput<"kb.get_chunk">): Promise<ToolOutput<"kb.get_chunk">> {
  const c = await getChunkRow(input.chunk_id);
  if (!c) throw new PermanentError(`chunk ${input.chunk_id} not found`);
  const { prev_id, next_id, ...chunk } = c;
  return { ...chunk, neighbours: { prev_id, next_id } };
}

export async function getSourceOutline(input: ToolInput<"kb.get_source_outline">): Promise<ToolOutput<"kb.get_source_outline">> {
  const [src] = await db.select().from(sources).where(eq(sources.id, input.source_id));
  if (!src) throw new PermanentError(`source ${input.source_id} not found`);
  const rows = await db
    .select({ id: sourceChunks.id, locator: sourceChunks.locator, heading: sourceChunks.heading, subtopicIds: sourceChunks.subtopicIds })
    .from(sourceChunks).where(eq(sourceChunks.sourceId, input.source_id)).orderBy(sourceChunks.seq);
  // Slides are one unit per chunk; video/textbook units are the chunks themselves, grouped by heading when one exists.
  const units = rows.map((r) => ({ locator: r.locator as Record<string, unknown>, heading: r.heading, chunk_ids: [r.id], subtopic_ids: r.subtopicIds }));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(sourceChunks).where(eq(sourceChunks.sourceId, input.source_id));
  return {
    source: {
      id: src.id, kind: src.kind, title: src.title, provider: src.provider, url: src.url, license: src.license,
      duration_sec: src.durationSec, unit_count: src.unitCount, chunk_count: n,
    },
    units,
  };
}
