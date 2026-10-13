/**
 * Textbook → page-anchored text chunks (v4 §N1.3). One `pdftotext` call per page keeps the
 * page number exact; running headers, footers and page numbers are stripped before chunking.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IngestError, validateChunks, wordCount, type RawChunk } from "./types.js";

const run = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

export async function pdfPageCount(pdfPath: string): Promise<number> {
  const { stdout } = await run("pdfinfo", [pdfPath]);
  const m = /^Pages:\s+(\d+)/m.exec(stdout);
  if (!m) throw new IngestError(`pdfinfo gave no page count for ${pdfPath}`);
  return Number(m[1]);
}

export async function extractPages(pdfPath: string, first?: number, last?: number): Promise<string[]> {
  const total = await pdfPageCount(pdfPath);
  const from = first ?? 1;
  const to = Math.min(last ?? total, total);
  const pages: string[] = [];
  for (let p = from; p <= to; p++) {
    const { stdout } = await run("pdftotext", ["-layout", "-f", String(p), "-l", String(p), pdfPath, "-"], { maxBuffer: MAX_BUFFER });
    pages.push(stdout);
  }
  return pages;
}

const BARE_PAGE_NUMBER = /^\s*(?:page\s+)?(?:\d{1,4}|[ivxlc]{1,6})\s*$/i;

function shapeKey(line: string): string {
  return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/** Lines that repeat (modulo digits) in the first/last 3 non-empty lines of ≥40% of pages are running headers/footers. */
export function findRunningLines(pages: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const lines = page.split("\n").map((l) => l.trim()).filter(Boolean);
    const edge = new Set([...lines.slice(0, 3), ...lines.slice(-3)].filter((l) => l.length <= 80).map(shapeKey));
    for (const k of edge) if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
}

export function cleanPage(page: string, running: Set<string>): string {
  const lines = page.split("\n").map((l) => l.replace(/\s+$/, ""));
  const nonEmpty = lines.map((l, i) => [l.trim(), i] as const).filter(([l]) => l);
  const edgeIdx = new Set([...nonEmpty.slice(0, 3), ...nonEmpty.slice(-3)].map(([, i]) => i));
  return lines
    .filter((l, i) => !(BARE_PAGE_NUMBER.test(l) && edgeIdx.has(i)) && !(edgeIdx.has(i) && l.trim().length <= 80 && running.has(shapeKey(l.trim()))))
    .join("\n");
}

const HEADING = /^(?:chapter\s+\d+\b.*|\d+(?:\.\d+){0,3}\.?\s+[A-Z][^.!?]{2,80})$/;

function isHeading(line: string): boolean {
  const t = line.trim();
  return t.length <= 90 && HEADING.test(t);
}

/** Splits a cleaned page into paragraphs, tracking the nearest heading seen so far. */
export function pageParagraphs(page: string, carriedSection: string | null): { paras: Array<{ text: string; section: string | null }>; section: string | null } {
  let section = carriedSection;
  const paras: Array<{ text: string; section: string | null }> = [];
  for (const block of page.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (isHeading(lines[0])) {
      section = lines[0];
      lines.shift();
      if (lines.length === 0) continue;
    }
    const text = lines.join(" ").replace(/-\s+(?=[a-z])/g, "").replace(/\s+/g, " ").trim();
    if (text) paras.push({ text, section });
  }
  return { paras, section };
}

export type TextbookOptions = { targetWords?: number; minWords?: number };

export function buildTextbookChunks(pages: string[], firstPage: number, opts: TextbookOptions = {}): RawChunk[] {
  const target = opts.targetWords ?? 270; // ≈350 tokens
  const minWords = opts.minWords ?? 25;
  const running = findRunningLines(pages);
  const chunks: RawChunk[] = [];
  let section: string | null = null;

  pages.forEach((raw, idx) => {
    const page = firstPage + idx;
    const parsed = pageParagraphs(cleanPage(raw, running), section);
    section = parsed.section;
    let buf: string[] = [];
    let bufSection: string | null = null;
    const flush = () => {
      const text = buf.join("\n\n").trim();
      if (wordCount(text) >= minWords) {
        chunks.push({
          seq: chunks.length, modality: "page_text", locator: { page, section: bufSection },
          heading: bufSection, text, visualDescription: null, assetPath: null, lowInformation: false,
        });
      }
      buf = [];
    };
    for (const p of parsed.paras) {
      // a chunk never spans two sections, so its heading (and locator.section) is exact
      if (buf.length > 0 && (p.section !== bufSection || wordCount(buf.join(" ")) + wordCount(p.text) > target)) flush();
      if (buf.length === 0) bufSection = p.section;
      buf.push(p.text);
    }
    flush();
  });

  validateChunks(chunks);
  return chunks;
}

export async function ingestTextbookPdf(pdfPath: string, opts: TextbookOptions & { firstPage?: number; lastPage?: number } = {}): Promise<RawChunk[]> {
  const first = opts.firstPage ?? 1;
  const pages = await extractPages(pdfPath, first, opts.lastPage);
  return buildTextbookChunks(pages, first, opts);
}

export function textbookDeepLink(pdfUrl: string, page: number): string {
  return `${pdfUrl.split("#")[0]}#page=${page}`;
}
