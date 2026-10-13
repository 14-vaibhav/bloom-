/**
 * KB segments become resources (v4 §N6.3): consecutive chunks of one source tagged to the same
 * subtopic are grouped into a segment and upserted as a `resources` row. The planner, resourceFit,
 * the Curator and live URL verification then work on course material with no code change, and a
 * LEARN card reads "Lecture 5, 14:20–22:05" instead of an external link.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { resources, sourceChunks, sources, subtopics } from "../../db/schema.js";
import { formatTimestamp, videoDeepLink } from "./video.js";
import { textbookDeepLink } from "./textbook.js";

export type SegChunk = {
  id: string; seq: number; subtopicIds: string[]; conceptIds: string[]; locator: Record<string, unknown>;
  text: string; heading: string | null; lowInformation: boolean;
};
export type Segment = { subtopicId: string; chunks: SegChunk[] };

export const MAX_VIDEO_SEC = 20 * 60;
export const MAX_SLIDES = 10;
export const MAX_PAGES = 6;

function span(kind: string, chunks: SegChunk[]): number {
  const first = chunks[0].locator, last = chunks[chunks.length - 1].locator;
  if (kind === "video") return Number(last.t_end) - Number(first.t_start);
  if (kind === "slides") return Number(last.slide) - Number(first.slide) + 1;
  return Number(last.page) - Number(first.page) + 1;
}
const LIMIT: Record<string, number> = { video: MAX_VIDEO_SEC, slides: MAX_SLIDES, textbook: MAX_PAGES };

/** Pure: consecutive (by seq) tagged chunks with the same primary subtopic, split at the per-kind span limit. */
export function groupSegments(kind: string, chunks: SegChunk[]): Segment[] {
  const ordered = [...chunks].sort((a, b) => a.seq - b.seq);
  const out: Segment[] = [];
  let cur: Segment | null = null;
  let prevSeq = -2;
  for (const c of ordered) {
    const primary = c.lowInformation ? undefined : c.subtopicIds[0];
    if (!primary) { cur = null; prevSeq = c.seq; continue; }
    const contiguous = cur !== null && cur.subtopicId === primary && c.seq - prevSeq === 1;
    if (cur && contiguous && span(kind, [...cur.chunks, c]) <= LIMIT[kind]) {
      cur.chunks.push(c);
    } else {
      cur = { subtopicId: primary, chunks: [c] };
      out.push(cur);
    }
    prevSeq = c.seq;
  }
  return out;
}

export function segmentLabel(kind: string, title: string, chunks: SegChunk[]): string {
  const first = chunks[0].locator, last = chunks[chunks.length - 1].locator;
  if (kind === "video") return `${title}, ${formatTimestamp(Number(first.t_start))}–${formatTimestamp(Number(last.t_end))}`;
  if (kind === "slides") return Number(first.slide) === Number(last.slide) ? `${title}, slide ${first.slide}` : `${title}, slides ${first.slide}–${last.slide}`;
  return Number(first.page) === Number(last.page) ? `${title}, p. ${first.page}` : `${title}, pp. ${first.page}–${last.page}`;
}

export function segmentRange(kind: string, chunks: SegChunk[]): Record<string, number> {
  const first = chunks[0].locator, last = chunks[chunks.length - 1].locator;
  if (kind === "video") return { t_start: Number(first.t_start), t_end: Number(last.t_end) };
  if (kind === "slides") return { slide_start: Number(first.slide), slide_end: Number(last.slide) };
  return { page_start: Number(first.page), page_end: Number(last.page) };
}

export function segmentDurationMin(kind: string, chunks: SegChunk[]): number {
  if (kind === "video") return Math.max(5, Math.ceil(span(kind, chunks) / 60));
  if (kind === "slides") return Math.max(5, Math.ceil(span(kind, chunks) * 2));
  const words = chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
  return Math.max(5, Math.ceil(words / 200));
}

export function segmentUrl(kind: string, url: string | null, chunks: SegChunk[]): string | null {
  if (!url) return null;
  const first = chunks[0].locator;
  if (kind === "video") return videoDeepLink(url, Number(first.t_start));
  if (kind === "slides") return `${url.split("#")[0]}#page=${first.slide}`;
  return textbookDeepLink(url, Number(first.page));
}

const RESOURCE_TYPE: Record<string, "video" | "doc" | "article"> = { video: "video", slides: "doc", textbook: "article" };

export async function buildSegments(sourceId?: string): Promise<{ upserted: number; removed: number; skippedNoUrl: number }> {
  const srcRows = sourceId ? await db.select().from(sources).where(eq(sources.id, sourceId)) : await db.select().from(sources);
  let upserted = 0, removed = 0, skippedNoUrl = 0;
  for (const src of srcRows) {
    const chunks = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, src.id));
    const segs = groupSegments(src.kind, chunks.map((c) => ({ id: c.id, seq: c.seq, subtopicIds: c.subtopicIds, conceptIds: c.conceptIds, locator: c.locator as Record<string, unknown>, text: c.text, heading: c.heading, lowInformation: c.lowInformation })));
    const subtopicInfo = new Map<string, { topicId: string; name: string; difficulty: number }>();
    const ids = [...new Set(segs.map((s) => s.subtopicId))];
    if (ids.length) {
      for (const r of await db.select().from(subtopics).where(inArray(subtopics.id, ids))) subtopicInfo.set(r.id, { topicId: r.topicId, name: r.name, difficulty: r.difficulty });
    }
    const keep: string[] = [];
    for (const seg of segs) {
      const info = subtopicInfo.get(seg.subtopicId);
      const url = segmentUrl(src.kind, src.url, seg.chunks);
      if (!info) continue;
      if (!url) { skippedNoUrl++; continue; }
      const first = seg.chunks[0], last = seg.chunks[seg.chunks.length - 1];
      const id = `kb_${src.id}_${first.seq}-${last.seq}`;
      const label = segmentLabel(src.kind, src.title, seg.chunks);
      const description = `${label}. ${info.name}. ${seg.chunks.map((c) => [c.heading, c.text].filter(Boolean).join(" ")).join(" ").replace(/\s+/g, " ").slice(0, 700)}`;
      const values = {
        id, title: `${label} — ${info.name}`, provider: src.provider ?? src.title, url, type: RESOURCE_TYPE[src.kind],
        difficulty: info.difficulty, durationMin: segmentDurationMin(src.kind, seg.chunks), quality: "0.85",
        topicIds: [info.topicId], subtopicIds: [seg.subtopicId], conceptIds: [...new Set(seg.chunks.flatMap((c) => c.conceptIds))],
        description, isLive: true, sourceId: src.id, locatorRange: segmentRange(src.kind, seg.chunks),
      };
      await db.insert(resources).values(values).onConflictDoUpdate({ target: resources.id, set: values });
      // mean of the chunk embeddings — no extra embedding call
      await db.execute(sql`update resources set embedding = (select avg(embedding) from source_chunks where id = any(${sql.raw(`ARRAY[${seg.chunks.map((c) => `'${c.id.replace(/'/g, "''")}'`).join(",")}]::text[]`)})) where id = ${id}`);
      keep.push(id);
      upserted++;
    }
    const stale = await db.select({ id: resources.id }).from(resources).where(eq(resources.sourceId, src.id));
    const drop = stale.map((s) => s.id).filter((id) => !keep.includes(id));
    if (drop.length) {
      // plans may reference old segment ids; retire rather than delete
      await db.update(resources).set({ isLive: false }).where(inArray(resources.id, drop));
      removed += drop.length;
    }
  }
  return { upserted, removed, skippedNoUrl };
}
