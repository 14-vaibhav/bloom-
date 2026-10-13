/**
 * Extractive fallback (v4 §N3.3, §N4.1): the top chunks verbatim with their locators. Built so that
 * it passes K1–K4 by construction — the text IS the chunk text, so degrading never costs honesty.
 */
import { wordCount } from "../kb/ingest/types.js";
import type { KbChunk } from "../kb/retrieval.js";
import type { Segment, TutorAnswer } from "./citationValidator.js";
import { QUOTE_MAX_WORDS, QUOTE_MIN_WORDS } from "./citationValidator.js";

function firstWords(text: string, n: number): string {
  return text.trim().split(/\s+/).slice(0, n).join(" ");
}

/** Up to two sentences, capped at 60 words. */
function excerpt(text: string): string {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
  return firstWords(sentences.slice(0, 2).join(" ").trim(), 60);
}

export function extractiveAnswer(chunks: KbChunk[], limit = 3): TutorAnswer {
  const picked: KbChunk[] = [];
  const kinds = new Set<string>();
  // prefer one chunk per kind first, then fill by rank
  for (const c of chunks) if (!kinds.has(c.kind) && picked.length < limit) { picked.push(c); kinds.add(c.kind); }
  for (const c of chunks) if (picked.length < limit && !picked.includes(c)) picked.push(c);

  const segments: Segment[] = [];
  for (const c of picked) {
    const source = (c.text.trim() ? c.text : c.visual_description ?? "").trim();
    if (!source) continue;
    const body = excerpt(source);
    // The quote must be 6–30 words; short chunks are used whole if long enough, otherwise skipped.
    const quote = firstWords(body, QUOTE_MAX_WORDS);
    if (wordCount(quote) < QUOTE_MIN_WORDS) continue;
    segments.push({ text: `${c.label}: ${body}`, chunk_ids: [c.chunk_id], quote });
  }
  return { segments, follow_up: null };
}
