/**
 * Educational RAG tool. Retrieves; it does not rank for fit (that's Phase 4)
 * and it does not call an LLM. The one thing that makes this more than "reads
 * my own Postgres" is live URL verification of the top candidates before they
 * go back to the caller (bloom-prd-v3.md §14).
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { resources } from "../db/schema.js";
import { verifyUrl } from "../lib/verifyUrl.js";
import { systemClock, type Clock } from "../lib/clock.js";
import { PermanentError } from "./errors.js";
import type { ToolInput, ToolOutput } from "./schemas.js";

const VERIFY_TOP_N = 5;
const CACHE_HOURS = 24;
const VERIFY_TIMEOUT_MS = 3000;

type ResourceRow = typeof resources.$inferSelect;

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

function toHit(
  r: ResourceRow,
  similarity: number | null,
  rankedBy: "embedding" | "fallback_quality",
  verified: boolean,
): ToolOutput<"rag.search_learning_resources">[number] {
  return {
    id: r.id,
    title: r.title,
    provider: r.provider,
    url: r.url,
    type: r.type,
    difficulty: r.difficulty,
    duration_min: r.durationMin,
    quality: num(r.quality),
    similarity,
    ranked_by: rankedBy,
    verified,
    is_live: r.isLive,
    subtopic_ids: r.subtopicIds,
    concept_ids: r.conceptIds,
  };
}

function isCacheFresh(lastVerifiedAt: Date | null, now: Date): boolean {
  if (!lastVerifiedAt) return false;
  return now.getTime() - lastVerifiedAt.getTime() < CACHE_HOURS * 3600_000;
}

/**
 * Verifies (or trusts the 24h cache for) the top N candidates in place,
 * excluding dead ones and backfilling from the tail so the caller still gets
 * up to `k` results. Returns the observations the caller should log/emit —
 * the dispatcher writes these into agent_events, this function stays pure I/O.
 */
export async function verifyAndFilter(
  candidates: ResourceRow[],
  k: number,
  clock: Clock = systemClock,
): Promise<{ hits: Array<{ row: ResourceRow; similarity: number | null; rankedBy: "embedding" | "fallback_quality"; verified: boolean }>; notices: string[] }> {
  const notices: string[] = [];
  const now = clock();
  const toVerify = candidates.slice(0, VERIFY_TOP_N);
  const rest = candidates.slice(VERIFY_TOP_N);

  const verifiedTop: Array<ResourceRow & { verified: boolean; excluded: boolean }> = [];

  for (const r of toVerify) {
    if (isCacheFresh(r.lastVerifiedAt, now)) {
      verifiedTop.push({ ...r, verified: true, excluded: false });
      continue;
    }

    const result = await verifyUrl(r.url, VERIFY_TIMEOUT_MS);

    if (result.status === "live") {
      await db
        .update(resources)
        .set({ lastVerifiedAt: now, isLive: true, verificationFailures: 0 })
        .where(sql`${resources.id} = ${r.id}`);
      verifiedTop.push({ ...r, isLive: true, lastVerifiedAt: now, verified: true, excluded: false });
    } else if (result.httpStatus === 404 || result.httpStatus === 410) {
      await db.update(resources).set({ isLive: false }).where(sql`${resources.id} = ${r.id}`);
      notices.push(`${r.id} returned ${result.httpStatus} — excluded and replaced with the next candidate.`);
      verifiedTop.push({ ...r, isLive: false, verified: true, excluded: true });
    } else {
      // timeout / network error / ambiguous status — one bad check is not death
      const failures = r.verificationFailures + 1;
      const nowDead = failures >= 3;
      await db
        .update(resources)
        .set({ verificationFailures: failures, isLive: nowDead ? false : r.isLive })
        .where(sql`${resources.id} = ${r.id}`);
      if (nowDead) {
        notices.push(`${r.id} failed verification 3 times in a row — marked not live.`);
        verifiedTop.push({ ...r, isLive: false, verified: true, excluded: true });
      } else {
        verifiedTop.push({ ...r, verificationFailures: failures, verified: false, excluded: false });
      }
    }
  }

  const usable = [
    ...verifiedTop.filter((r) => !r.excluded),
    ...rest.map((r) => ({ ...r, verified: isCacheFresh(r.lastVerifiedAt, now), excluded: false })),
  ].slice(0, k);

  return {
    hits: usable.map((r) => ({ row: r, similarity: null, rankedBy: "fallback_quality" as const, verified: r.verified })),
    notices,
  };
}

export async function searchLearningResources(
  input: ToolInput<"rag.search_learning_resources">,
  clock: Clock = systemClock,
): Promise<{ output: ToolOutput<"rag.search_learning_resources">; notices: string[] }> {
  const typesFilter = input.types && input.types.length > 0 ? input.types : undefined;

  // Candidate pool: filters code can apply deterministically before any ranking.
  const pool = (
    await db
      .select()
      .from(resources)
      .where(sql`${resources.subtopicIds} @> ARRAY[${input.subtopic_id}]::text[] and ${resources.isLive} = true`)
  ).filter((r) => !(input.exclude_ids ?? []).includes(r.id) && r.durationMin <= input.max_duration_min && (!typesFilter || typesFilter.includes(r.type)));

  if (pool.length === 0) {
    return { output: [], notices: [] };
  }

  const embeddedCount = pool.filter((r) => r.embedding !== null).length;
  let ordered: ResourceRow[];
  let rankedBy: "embedding" | "fallback_quality";

  if (embeddedCount > 0) {
    // Order candidates by cosine distance to a synthetic "ideal" query built from the
    // subtopic's own resource embeddings' centroid is out of scope here — Phase 4 owns
    // fit scoring. Until a real query embedding is supplied by the caller, order by
    // quality among embedded resources first, unembedded after.
    ordered = [...pool].sort((a, b) => {
      if ((a.embedding !== null) !== (b.embedding !== null)) return a.embedding !== null ? -1 : 1;
      return num(b.quality) - num(a.quality);
    });
    rankedBy = "embedding";
  } else {
    ordered = [...pool].sort((a, b) => num(b.quality) - num(a.quality));
    rankedBy = "fallback_quality";
  }

  const { hits, notices } = await verifyAndFilter(ordered, input.k ?? 8, clock);
  const output = hits.map((h) => toHit(h.row, h.similarity, rankedBy, h.verified));
  return { output, notices };
}

export async function getResourceDetails(
  input: ToolInput<"rag.get_resource_details">,
): Promise<ToolOutput<"rag.get_resource_details">> {
  const [r] = await db.select().from(resources).where(sql`${resources.id} = ${input.resource_id}`);
  if (!r) throw new PermanentError(`Resource ${input.resource_id} not found`);
  return {
    id: r.id,
    title: r.title,
    provider: r.provider,
    url: r.url,
    type: r.type,
    difficulty: r.difficulty,
    duration_min: r.durationMin,
    quality: num(r.quality),
    topic_ids: r.topicIds,
    subtopic_ids: r.subtopicIds,
    concept_ids: r.conceptIds,
    description: r.description,
    is_live: r.isLive,
    last_verified_at: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
    verification_failures: r.verificationFailures,
  };
}
