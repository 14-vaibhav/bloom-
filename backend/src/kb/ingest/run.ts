/** Ties an entry in kb-manifest.json to the right ingester, then embeds and tags. Used by the CLIs. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { buildReport, formatReport, persistReport } from "../report.js";
import { ingestSlidePdf } from "./slides.js";
import { embedPendingChunks, storeSource, type SourceMeta } from "./store.js";
import { buildSubtopicIndex, tagSource } from "./tagger.js";
import { ingestTextbookPdf, pdfPageCount } from "./textbook.js";
import { ingestVideoCaptions, parseCaptions } from "./video.js";
import type { RawChunk, SourceKind } from "./types.js";

export const BACKEND_ROOT = path.resolve(import.meta.dirname, "../../..");
export const ASSET_ROOT = path.join(BACKEND_ROOT, "kb-assets");

export type ManifestEntry = {
  id: string; subject_id: string; kind: SourceKind; title: string; provider?: string; url: string; license: string;
  /** path under backend/kb-data/ (captions for video, PDF for slides/textbook) */
  file: string;
  first_page?: number; last_page?: number; allow_empty_slides?: boolean;
};

export async function loadManifest(): Promise<ManifestEntry[]> {
  const raw = JSON.parse(await readFile(path.join(BACKEND_ROOT, "kb-manifest.json"), "utf8"));
  return raw.sources as ManifestEntry[];
}

export async function ingestEntry(entry: ManifestEntry, log: (m: string) => void = console.log, force = false): Promise<void> {
  const file = path.join(BACKEND_ROOT, "kb-data", entry.file);
  let chunks: RawChunk[];
  let durationSec: number | null = null;
  let unitCount: number | null = null;
  if (entry.kind === "video") {
    const text = await readFile(file, "utf8");
    chunks = ingestVideoCaptions(text);
    const cues = parseCaptions(text);
    durationSec = Math.round(cues[cues.length - 1].end);
  } else if (entry.kind === "slides") {
    chunks = await ingestSlidePdf({
      pdfPath: file, assetDir: path.join(ASSET_ROOT, entry.id), assetPrefix: entry.id,
      allowEmpty: entry.allow_empty_slides ?? true,
      onProgress: (d, t) => log(`  slide ${d}/${t}`),
    });
    unitCount = await pdfPageCount(file);
  } else {
    chunks = await ingestTextbookPdf(file, { firstPage: entry.first_page, lastPage: entry.last_page });
    unitCount = await pdfPageCount(file);
  }
  const meta: SourceMeta = { id: entry.id, subjectId: entry.subject_id, kind: entry.kind, title: entry.title, provider: entry.provider, url: entry.url, license: entry.license, durationSec, unitCount };
  const res = await storeSource(meta, chunks, { force });
  log(`${entry.id}: ${res.status} (${res.chunks} chunks)`);
  const embedded = await embedPendingChunks(entry.id, 4, (d, t) => d % 20 === 0 && log(`  embed ${d}/${t}`));
  const tag = await tagSource(entry.id, entry.subject_id);
  log(`${entry.id}: embedded ${embedded}, tagged ${tag.tagged}, untagged ${tag.untagged}`);
}

export async function runCli(kind: SourceKind, argv: string[]): Promise<void> {
  const manifest = await loadManifest();
  const force = argv.includes("--force");
  const ids = argv.filter((a) => !a.startsWith("--"));
  const entries = manifest.filter((e) => e.kind === kind && (ids.length === 0 || ids.includes(e.id)));
  if (entries.length === 0) throw new Error(`No ${kind} sources in kb-manifest.json${ids.length ? ` matching ${ids.join(", ")}` : ""}`);
  for (const e of entries) await ingestEntry(e, console.log, force);
  const subjects = [...new Set(entries.map((e) => e.subject_id))];
  for (const s of subjects) {
    const report = await buildReport(s);
    await persistReport(report);
    console.log("\n" + formatReport(report));
  }
}

export async function sourceExists(id: string): Promise<boolean> {
  const [r] = await db.select({ id: sources.id }).from(sources).where(eq(sources.id, id));
  return !!r;
}

export { buildSubtopicIndex };
