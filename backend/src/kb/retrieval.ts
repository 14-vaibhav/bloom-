/**
 * Hybrid retrieval over source_chunks (v4 §N3.1): vector top-20 + lexical top-20 →
 * reciprocal-rank fusion → top 8, with a kind-diversity swap so one answer can cite a lecture
 * timestamp, a slide and a textbook page together. Falls back to lexical-only when the
 * embedding call fails. An exact scan is used (no ANN index): at a few hundred rows it is
 * faster and has perfect recall.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { embedText } from "../lib/embeddingClient.js";
import { vectorLiteral } from "./ingest/store.js";
import { normalizeText } from "./ingest/types.js";
import { formatTimestamp, videoDeepLink } from "./ingest/video.js";
import { textbookDeepLink } from "./ingest/textbook.js";

export const RRF_K = 60;
export const TOP_N = 8;
/** Best chunk of a missing kind is swapped in when its fused score is within this of the 8th result. */
export const KIND_DIVERSITY_MARGIN = 0.004;
/** Minimum cosine similarity of the best chunk for the retrieval to count as evidence (hybrid mode). */
export const EVIDENCE_SIM = Number(process.env.KB_EVIDENCE_SIM ?? 0.55);
/** Lexical mode: share of distinct query terms that the best chunk must contain. */
export const EVIDENCE_LEXICAL_COVERAGE = 0.5;
const SUBTOPIC_BOOST = 1.2;

export type SourceKindName = "video" | "slides" | "textbook";

export type KbChunk = {
  chunk_id: string; source_id: string; source_title: string; kind: SourceKindName;
  modality: string; locator: Record<string, unknown>; label: string; deep_link: string;
  asset_url: string | null; text: string; visual_description: string | null;
  subtopic_ids: string[]; score: number;
};

export type SearchResult = {
  retrieval_mode: "hybrid" | "lexical";
  chunks: KbChunk[];
  /** Always filled, even when `chunks` is empty (the tutor shows these when it declines). */
  nearest: KbChunk[];
  top_similarity: number | null;
};

type Row = {
  id: string; source_id: string; source_title: string; source_url: string | null; kind: SourceKindName;
  modality: string; locator: Record<string, unknown>; text: string; visual_description: string | null;
  asset_path: string | null; subtopic_ids: string[]; sim?: number | null;
};

export function chunkLabel(kind: SourceKindName, title: string, locator: Record<string, unknown>): string {
  if (kind === "video") return `${title} · ${formatTimestamp(Number(locator.t_start))}`;
  if (kind === "slides") return `${title} · slide ${locator.slide}`;
  return `${title} · p. ${locator.page}`;
}

export function chunkDeepLink(kind: SourceKindName, url: string | null, locator: Record<string, unknown>, assetUrl: string | null): string {
  if (kind === "video") return url ? videoDeepLink(url, Number(locator.t_start)) : "";
  if (kind === "slides") return assetUrl ?? url ?? "";
  return url ? textbookDeepLink(url, Number(locator.page)) : "";
}

export function toKbChunk(r: Row, score: number): KbChunk {
  const assetUrl = r.asset_path ? `/kb-assets/${r.asset_path}` : null;
  return {
    chunk_id: r.id, source_id: r.source_id, source_title: r.source_title, kind: r.kind, modality: r.modality,
    locator: r.locator, label: chunkLabel(r.kind, r.source_title, r.locator),
    deep_link: chunkDeepLink(r.kind, r.source_url, r.locator, assetUrl), asset_url: assetUrl,
    text: r.text, visual_description: r.visual_description, subtopic_ids: r.subtopic_ids, score: Math.round(score * 10000) / 10000,
  };
}

const STOP = new Set("a an and are as at be by do does for from how i in is it of on or that the this to was what when where which who why with you your me my we can about between difference explain tell".split(" "));

export function queryTerms(q: string): string[] {
  return [...new Set(normalizeText(q).split(" ").filter((t) => t.length > 1 && !STOP.has(t)))];
}

const SELECT = sql`
  c.id, c.source_id, s.title as source_title, s.url as source_url, s.kind, c.modality, c.locator, c.text,
  c.visual_description, c.asset_path, c.subtopic_ids`;

function kindFilter(kinds?: SourceKindName[]) {
  return kinds && kinds.length ? sql` and s.kind = any(${sql.raw(`ARRAY[${kinds.map((k) => `'${k}'`).join(",")}]::text[]`)})` : sql``;
}

async function vectorTop(qvec: number[], kinds: SourceKindName[] | undefined, limit: number): Promise<Row[]> {
  const res = await db.execute<Row>(sql`
    select ${SELECT}, 1 - (c.embedding <=> ${vectorLiteral(qvec)}::vector) as sim
    from source_chunks c join sources s on s.id = c.source_id
    where not c.low_information and c.embedding is not null ${kindFilter(kinds)}
    order by c.embedding <=> ${vectorLiteral(qvec)}::vector limit ${limit}`);
  return res.rows;
}

async function lexicalTop(terms: string[], kinds: SourceKindName[] | undefined, limit: number): Promise<Row[]> {
  const safe = terms.map((t) => t.replace(/[^a-z0-9]/g, "")).filter(Boolean);
  if (safe.length === 0) return [];
  const tsq = safe.join(" | ");
  const res = await db.execute<Row>(sql`
    select ${SELECT}
    from source_chunks c join sources s on s.id = c.source_id
    where not c.low_information and c.tsv @@ to_tsquery('english', ${tsq}) ${kindFilter(kinds)}
    order by ts_rank_cd(c.tsv, to_tsquery('english', ${tsq})) desc limit ${limit}`);
  return res.rows;
}

export type FusedItem = { row: Row; score: number };

/** Reciprocal-rank fusion of any number of ranked lists. Pure. */
export function rrf(lists: Row[][], boostSubtopics: string[] = []): FusedItem[] {
  const scores = new Map<string, FusedItem>();
  for (const list of lists) {
    list.forEach((row, rank) => {
      const item = scores.get(row.id) ?? { row, score: 0 };
      item.score += 1 / (RRF_K + rank + 1);
      if (row.sim !== undefined && row.sim !== null) item.row = { ...item.row, sim: row.sim };
      scores.set(row.id, item);
    });
  }
  const items = [...scores.values()];
  if (boostSubtopics.length) {
    for (const it of items) if (it.row.subtopic_ids.some((s) => boostSubtopics.includes(s))) it.score *= SUBTOPIC_BOOST;
  }
  return items.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
}

/** Takes the top-N, then swaps in the best chunk of any kind that is absent but within the margin of the Nth. Pure. */
export function diversify(fused: FusedItem[], n = TOP_N, margin = KIND_DIVERSITY_MARGIN): FusedItem[] {
  const top = fused.slice(0, n);
  if (fused.length <= n) return top;
  const nth = top[top.length - 1].score;
  const kindsPresent = new Set(top.map((t) => t.row.kind));
  for (const candidate of fused.slice(n)) {
    if (kindsPresent.has(candidate.row.kind)) continue;
    if (nth - candidate.score > margin) continue;
    // replace the lowest-scored member of the most over-represented kind
    const counts = new Map<string, number>();
    for (const t of top) counts.set(t.row.kind, (counts.get(t.row.kind) ?? 0) + 1);
    const victimIdx = [...top.keys()].reverse().find((i) => (counts.get(top[i].row.kind) ?? 0) > 1);
    if (victimIdx === undefined) break;
    top.splice(victimIdx, 1, candidate);
    kindsPresent.add(candidate.row.kind);
    top.sort((a, b) => b.score - a.score);
  }
  return top;
}

export type SearchOptions = {
  query: string;
  subtopicIds?: string[];
  kinds?: SourceKindName[];
  k?: number;
  /** Injected in tests; defaults to the Gemini embedding client with a 3s timeout. */
  embedQuery?: (q: string) => Promise<number[]>;
  evidenceSim?: number;
};

export const embedQueryDefault = (q: string) => embedText(q, { timeoutMs: 3000 });

/** Test seam: the dispatcher-validated tool input cannot carry functions, so tests override these here. */
export const retrievalHooks: { embedQuery?: (q: string) => Promise<number[]>; evidenceSim?: number } = {};

export async function searchCourseContent(opts: SearchOptions): Promise<SearchResult & { notices: string[] }> {
  const k = Math.min(opts.k ?? TOP_N, 20);
  const notices: string[] = [];
  const terms = queryTerms(opts.query);

  let qvec: number[] | null = null;
  try {
    if (process.env.KB_FORCE_EMBED_FAIL === "true") throw new Error("embedding forced down");
    qvec = await (opts.embedQuery ?? retrievalHooks.embedQuery ?? embedQueryDefault)(opts.query);
  } catch {
    notices.push("Embedding unavailable — lexical retrieval used.");
  }

  const [vec, lex] = await Promise.all([qvec ? vectorTop(qvec, opts.kinds, 20) : Promise.resolve([]), lexicalTop(terms, opts.kinds, 20)]);
  const mode = qvec ? "hybrid" : "lexical";
  const fused = rrf(qvec ? [vec, lex] : [lex], opts.subtopicIds ?? []);
  const picked = diversify(fused, k);
  const topSim = vec.length ? Number(vec[0].sim ?? 0) : null;

  const toChunks = (items: FusedItem[]) => items.map((i) => toKbChunk(i.row, i.score));
  const nearest = toChunks(fused.slice(0, 3));

  let hasEvidence = false;
  if (mode === "hybrid") {
    hasEvidence = topSim !== null && topSim >= (opts.evidenceSim ?? retrievalHooks.evidenceSim ?? EVIDENCE_SIM);
  } else if (picked.length && terms.length) {
    const best = normalizeText(`${picked[0].row.text} ${picked[0].row.visual_description ?? ""}`).split(" ");
    const present = terms.filter((t) => best.includes(t)).length;
    hasEvidence = present / terms.length >= EVIDENCE_LEXICAL_COVERAGE && present >= Math.min(2, terms.length);
  }
  return { retrieval_mode: mode, chunks: hasEvidence ? toChunks(picked) : [], nearest, top_similarity: topSim, notices };
}

export async function getChunk(chunkId: string): Promise<(KbChunk & { prev_id: string | null; next_id: string | null }) | null> {
  const res = await db.execute<Row & { seq: number }>(sql`
    select ${SELECT}, c.seq from source_chunks c join sources s on s.id = c.source_id where c.id = ${chunkId}`);
  const r = res.rows[0];
  if (!r) return null;
  const nb = await db.execute<{ id: string; seq: number }>(sql`
    select id, seq from source_chunks where source_id = ${r.source_id} and seq in (${r.seq - 1}, ${r.seq + 1})`);
  return {
    ...toKbChunk(r, 0),
    prev_id: nb.rows.find((n) => n.seq === r.seq - 1)?.id ?? null,
    next_id: nb.rows.find((n) => n.seq === r.seq + 1)?.id ?? null,
  };
}
