/**
 * Video → timestamped transcript chunks (v4 §N1.1). Retrieval over speech, not video
 * understanding. Windows are 60–90s, snapped to a sentence end, with no overlap so every
 * chunk has one unambiguous time range.
 */
import { IngestError, validateChunks, type RawChunk } from "./types.js";

export type Cue = { start: number; end: number; text: string };

const TS = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function parseTimestamp(raw: string, line: number): number {
  const m = TS.exec(raw.trim());
  if (!m) throw new IngestError(`caption line ${line}: malformed timestamp "${raw.trim()}"`);
  const [, h, mi, s, ms] = m;
  if (Number(mi) > 59 || Number(s) > 59) throw new IngestError(`caption line ${line}: timestamp out of range "${raw.trim()}"`);
  return Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

function cleanCueText(t: string): string {
  return t
    .replace(/<[^>]+>/g, "") // inline tags / karaoke timing
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parses WebVTT or SRT. Throws IngestError on any malformed timestamp line. */
export function parseCaptions(source: string): Cue[] {
  const lines = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: Cue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("-->")) continue;
    const [a, b] = line.split("-->");
    const start = parseTimestamp(a, i + 1);
    const end = parseTimestamp(b.trim().split(/\s+/)[0], i + 1); // drop VTT cue settings
    if (end < start) throw new IngestError(`caption line ${i + 1}: end before start`);
    const textLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "") {
      if (lines[j].includes("-->")) break;
      textLines.push(lines[j]);
      j++;
    }
    const text = cleanCueText(textLines.join(" "));
    if (text) cues.push({ start, end, text });
    i = j - 1;
  }
  if (cues.length === 0) throw new IngestError("no cues found in caption file");
  return dedupeRolling(cues);
}

/** YouTube auto-captions repeat the previous line inside the next cue; drop that overlap. */
function dedupeRolling(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.text === cue.text) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    if (prev && cue.text.startsWith(prev.text)) {
      out[out.length - 1] = { start: prev.start, end: cue.end, text: cue.text };
      continue;
    }
    out.push({ ...cue });
  }
  return out;
}

const SENTENCE_END = /[.!?]["')\]]*$/;

export type TranscriptOptions = { minSec?: number; maxSec?: number };

export function chunkTranscript(cues: Cue[], opts: TranscriptOptions = {}): RawChunk[] {
  const minSec = opts.minSec ?? 60;
  const maxSec = opts.maxSec ?? 90;
  const chunks: RawChunk[] = [];
  let buf: Cue[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    const t_start = Math.round(buf[0].start);
    let t_end = Math.round(buf[buf.length - 1].end);
    if (t_end <= t_start) t_end = t_start + 1;
    chunks.push({
      seq: chunks.length,
      modality: "transcript",
      locator: { t_start, t_end },
      heading: null,
      text: buf.map((c) => c.text).join(" "),
      visualDescription: null,
      assetPath: null,
      lowInformation: false,
    });
    buf = [];
  };

  for (const cue of cues) {
    buf.push(cue);
    const dur = cue.end - buf[0].start;
    if (dur >= maxSec || (dur >= minSec && SENTENCE_END.test(cue.text))) flush();
  }
  flush();
  validateChunks(chunks);
  return chunks;
}

export function ingestVideoCaptions(captionText: string, opts?: TranscriptOptions): RawChunk[] {
  return chunkTranscript(parseCaptions(captionText), opts);
}

/** Extracts the 11-char YouTube id from a watch/embed/youtu.be URL. */
export function youtubeId(url: string): string | null {
  const m = /(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/.exec(url);
  return m ? m[1] : null;
}

export function videoDeepLink(url: string, tStart: number): string {
  const id = youtubeId(url);
  return id ? `https://www.youtube.com/watch?v=${id}&t=${tStart}s` : `${url}#t=${tStart}`;
}

export function videoEmbedUrl(url: string, tStart: number): string | null {
  const id = youtubeId(url);
  return id ? `https://www.youtube.com/embed/${id}?start=${tStart}` : null;
}

export function formatTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
