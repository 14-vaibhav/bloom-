/**
 * Closing the loop from a wrong answer to the source (v4 §N6.3): for each wrongly answered question,
 * its own source chunk (when it has one) plus the best chunk of every other kind tagged to the same
 * concept (falling back to the subtopic). Hidden, with a note, while the KB tool's breaker is open.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { toolHealth } from "../db/schema.js";
import { chunkDeepLink, chunkLabel, type SourceKindName } from "./retrieval.js";

export type ReviewSource = { chunk_id: string; source_id: string; kind: SourceKindName; label: string; deep_link: string; own: boolean };

type Row = { id: string; source_id: string; title: string; url: string | null; kind: SourceKindName; locator: Record<string, unknown>; asset_path: string | null };

function toReview(r: Row, own: boolean): ReviewSource {
  const assetUrl = r.asset_path ? `/kb-assets/${r.asset_path}` : null;
  return { chunk_id: r.id, source_id: r.source_id, kind: r.kind, label: chunkLabel(r.kind, r.title, r.locator), deep_link: chunkDeepLink(r.kind, r.url, r.locator, assetUrl), own };
}

const COLS = sql`c.id, c.source_id, s.title, s.url, s.kind, c.locator, c.asset_path`;

type Q = { id: string; subtopicId: string; conceptId: string | null; sourceChunkId: string | null };

export async function reviewSourcesFor(wrong: Q[]): Promise<{ review_sources: Record<string, ReviewSource[]>; review_sources_note: string | null }> {
  if (wrong.length === 0) return { review_sources: {}, review_sources_note: null };
  const [health] = await db.select().from(toolHealth).where(eq(toolHealth.toolName, "kb"));
  if (health && health.state === "open") {
    return { review_sources: {}, review_sources_note: "Knowledge base unavailable — source links are hidden until it recovers." };
  }
  const out: Record<string, ReviewSource[]> = {};
  try {
    for (const q of wrong) {
      const picked: ReviewSource[] = [];
      let ownKind: string | null = null;
      if (q.sourceChunkId) {
        const own = await db.execute<Row>(sql`select ${COLS} from source_chunks c join sources s on s.id = c.source_id where c.id = ${q.sourceChunkId}`);
        if (own.rows[0]) { picked.push(toReview(own.rows[0], true)); ownKind = own.rows[0].kind; }
      }
      const match = q.conceptId
        ? sql`(c.concept_ids @> ARRAY[${q.conceptId}]::text[] or c.subtopic_ids @> ARRAY[${q.subtopicId}]::text[])`
        : sql`c.subtopic_ids @> ARRAY[${q.subtopicId}]::text[]`;
      const best = await db.execute<Row>(sql`
        select distinct on (s.kind) ${COLS}
        from source_chunks c join sources s on s.id = c.source_id
        where not c.low_information and ${match}
        order by s.kind, (c.concept_ids @> ARRAY[${q.conceptId ?? ""}]::text[]) desc, c.tag_similarity desc nulls last`);
      for (const r of best.rows) if (r.kind !== ownKind) picked.push(toReview(r, false));
      if (picked.length) out[q.id] = picked;
    }
  } catch {
    return { review_sources: {}, review_sources_note: "Source links could not be loaded." };
  }
  return { review_sources: out, review_sources_note: null };
}
