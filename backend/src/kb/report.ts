/** Ingest report (v4 §N1.6): per-source counts and the subtopic × source-kind coverage grid. */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { sources, subtopics, topics } from "../db/schema.js";

export type SourceRow = { id: string; kind: string; title: string; license: string | null; chunks: number; tagged: number; untagged: number; low_info: number; ingested_at: string | null; by_modality: Record<string, number> };
export type CoverageRow = { subtopic_id: string; name: string; video: number; slides: number; textbook: number; single_source: boolean };
export type KbReport = { sources: SourceRow[]; coverage: CoverageRow[] };

export async function buildReport(subjectId?: string): Promise<KbReport> {
  const filter = subjectId ? sql`where s.subject_id = ${subjectId}` : sql``;
  const srcRows = await db.execute<{
    id: string; kind: string; title: string; license: string | null; ingested_at: Date | null;
    chunks: number; tagged: number; low_info: number; modality: string | null; n: number;
  }>(sql`
    select s.id, s.kind, s.title, s.license, s.ingested_at, c.modality,
           count(c.id)::int as n,
           count(c.id)::int as chunks,
           count(*) filter (where cardinality(c.subtopic_ids) > 0)::int as tagged,
           count(*) filter (where c.low_information)::int as low_info
    from sources s left join source_chunks c on c.source_id = s.id ${filter}
    group by s.id, c.modality order by s.id`);
  const bySource = new Map<string, SourceRow>();
  for (const r of srcRows.rows) {
    const row = bySource.get(r.id) ?? { id: r.id, kind: r.kind, title: r.title, license: r.license, chunks: 0, tagged: 0, untagged: 0, low_info: 0, ingested_at: r.ingested_at ? new Date(r.ingested_at).toISOString() : null, by_modality: {} };
    row.chunks += r.chunks; row.tagged += r.tagged; row.low_info += r.low_info;
    if (r.modality) row.by_modality[r.modality] = r.n;
    bySource.set(r.id, row);
  }
  for (const row of bySource.values()) row.untagged = row.chunks - row.tagged;

  const subs = await db
    .select({ id: subtopics.id, name: subtopics.name })
    .from(subtopics).innerJoin(topics, eq(topics.id, subtopics.topicId))
    .where(subjectId ? eq(topics.subjectId, subjectId) : sql`true`);
  const cov = await db.execute<{ subtopic_id: string; kind: string; n: number }>(sql`
    select st as subtopic_id, s.kind, count(*)::int as n
    from source_chunks c join sources s on s.id = c.source_id, unnest(c.subtopic_ids) as st
    where not c.low_information ${subjectId ? sql`and s.subject_id = ${subjectId}` : sql``}
    group by st, s.kind`);
  const grid = new Map<string, { video: number; slides: number; textbook: number }>();
  for (const r of cov.rows) {
    const g = grid.get(r.subtopic_id) ?? { video: 0, slides: 0, textbook: 0 };
    (g as Record<string, number>)[r.kind] = r.n;
    grid.set(r.subtopic_id, g);
  }
  const coverage: CoverageRow[] = subs
    .filter((s) => grid.has(s.id))
    .map((s) => {
      const g = grid.get(s.id)!;
      return { subtopic_id: s.id, name: s.name, ...g, single_source: [g.video, g.slides, g.textbook].filter((n) => n > 0).length < 2 };
    })
    .sort((a, b) => a.subtopic_id.localeCompare(b.subtopic_id));
  return { sources: [...bySource.values()], coverage };
}

export function formatReport(r: KbReport): string {
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const lines = [pad("source", 28) + pad("kind", 10) + pad("chunks", 8) + pad("tagged", 8) + pad("untagged", 10) + "low_info"];
  for (const s of r.sources) lines.push(pad(s.id, 28) + pad(s.kind, 10) + pad(s.chunks, 8) + pad(s.tagged, 8) + pad(s.untagged, 10) + s.low_info);
  lines.push("", pad("coverage by subtopic", 34) + pad("video", 8) + pad("slides", 8) + "textbook");
  for (const c of r.coverage) lines.push(pad(c.subtopic_id, 34) + pad(c.video, 8) + pad(c.slides, 8) + c.textbook + (c.single_source ? "   ← single-source gap" : ""));
  return lines.join("\n");
}

export async function persistReport(r: KbReport): Promise<void> {
  for (const s of r.sources) {
    await db.update(sources).set({ ingestReport: { chunks: s.chunks, tagged: s.tagged, untagged: s.untagged, low_info: s.low_info, by_modality: s.by_modality, at: new Date().toISOString() } }).where(eq(sources.id, s.id));
  }
}
