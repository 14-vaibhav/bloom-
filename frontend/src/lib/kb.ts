import type { KbChunk, SourceKind } from "./types";

export const KIND_LABEL: Record<SourceKind, string> = { video: "Lecture", slides: "Slides", textbook: "Textbook" };

export const KIND_STYLE: Record<SourceKind, string> = {
  video: "border-sky-800 bg-sky-500/10 text-sky-200 hover:border-sky-500",
  slides: "border-violet-800 bg-violet-500/10 text-violet-200 hover:border-violet-500",
  textbook: "border-emerald-800 bg-emerald-500/10 text-emerald-200 hover:border-emerald-500",
};

export const KIND_ICON: Record<SourceKind, string> = { video: "▶", slides: "▤", textbook: "❡" };

/** YouTube watch/short URL + a start time → the embed URL (null when the source is not on YouTube). */
export function youtubeEmbed(deepLink: string, tStart: number): string | null {
  const m = /(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/.exec(deepLink);
  return m ? `https://www.youtube.com/embed/${m[1]}?start=${Math.floor(tStart)}` : null;
}

/** Splits `text` around the first place the quote occurs, ignoring case and punctuation differences. */
export function splitAtQuote(text: string, quote: string): [string, string, string] | null {
  const words = quote.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[^A-Za-z0-9]/g, "")).filter(Boolean);
  if (words.length === 0) return null;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^A-Za-z0-9]+"), "i");
  const m = re.exec(text);
  return m ? [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)] : null;
}

export function chunkKey(c: Pick<KbChunk, "chunk_id">): string {
  return c.chunk_id;
}
