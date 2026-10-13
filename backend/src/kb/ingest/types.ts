/**
 * Shared shapes for the three ingesters (v4 §N1). Ingesters are pure library
 * functions that return RawChunk[]; persistence (store.ts) and tagging (tagger.ts)
 * are separate steps so each can be tested alone.
 */

export type Modality = "transcript" | "page_text" | "slide_vision" | "keyframe_vision";
export type SourceKind = "video" | "slides" | "textbook";

export type Locator =
  | { t_start: number; t_end: number }
  | { page: number; section?: string | null }
  | { slide: number };

export type RawChunk = {
  seq: number;
  modality: Modality;
  locator: Locator;
  heading: string | null;
  text: string;
  visualDescription: string | null;
  assetPath: string | null;
  lowInformation: boolean;
};

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

/** Lowercase, strip punctuation, collapse whitespace — used for quote matching (K3, §N6.1) and duplicate detection. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Throws on duplicate normalised text within one source, empty text, or a malformed locator. */
export function validateChunks(chunks: RawChunk[]): void {
  const seen = new Map<string, number>();
  for (const c of chunks) {
    if (!c.text.trim() && !(c.visualDescription ?? "").trim()) {
      throw new IngestError(`chunk ${c.seq}: empty text and empty visual description`);
    }
    const loc = c.locator as Record<string, unknown>;
    if ("t_start" in loc) {
      const { t_start, t_end } = loc as { t_start: number; t_end: number };
      if (!Number.isFinite(t_start) || !Number.isFinite(t_end) || t_start < 0 || t_end <= t_start) {
        throw new IngestError(`chunk ${c.seq}: bad time range ${t_start}–${t_end}`);
      }
    } else if ("page" in loc) {
      const page = loc.page as number;
      if (!Number.isInteger(page) || page < 1) throw new IngestError(`chunk ${c.seq}: bad page ${page}`);
    } else if ("slide" in loc) {
      const slide = loc.slide as number;
      if (!Number.isInteger(slide) || slide < 1) throw new IngestError(`chunk ${c.seq}: bad slide ${slide}`);
    } else {
      throw new IngestError(`chunk ${c.seq}: locator has no t_start, page or slide`);
    }
    const key = normalizeText(`${c.text} ${c.visualDescription ?? ""}`);
    const prior = seen.get(key);
    if (prior !== undefined) throw new IngestError(`chunk ${c.seq} duplicates chunk ${prior}`);
    seen.set(key, c.seq);
  }
}
