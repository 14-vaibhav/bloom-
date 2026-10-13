import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSlideChunks } from "../../src/kb/ingest/slides.js";
import { buildTextbookChunks, cleanPage, findRunningLines } from "../../src/kb/ingest/textbook.js";
import { IngestError, normalizeText, validateChunks, type RawChunk } from "../../src/kb/ingest/types.js";
import { chunkTranscript, formatTimestamp, ingestVideoCaptions, parseCaptions, videoDeepLink, videoEmbedUrl } from "../../src/kb/ingest/video.js";

const vtt = readFileSync(path.resolve(import.meta.dirname, "../fixtures/kb/sample.vtt"), "utf8");

describe("video ingester", () => {
  it("produces non-overlapping windows snapped to sentence ends", () => {
    const chunks = ingestVideoCaptions(vtt);
    expect(chunks.length).toBe(2);
    const [a, b] = chunks.map((c) => c.locator as { t_start: number; t_end: number });
    expect(a).toEqual({ t_start: 0, t_end: 65 });
    expect(b.t_start).toBe(a.t_end);
    expect(chunks[0].text).toMatch(/collision\.$/);
    expect(chunks.every((c) => c.modality === "transcript")).toBe(true);
  });
  it("builds deep links and embeds", () => {
    expect(videoDeepLink("https://www.youtube.com/watch?v=abcdefghijk", 860)).toBe("https://www.youtube.com/watch?v=abcdefghijk&t=860s");
    expect(videoEmbedUrl("https://youtu.be/abcdefghijk", 860)).toBe("https://www.youtube.com/embed/abcdefghijk?start=860");
    expect(formatTimestamp(860)).toBe("14:20");
  });
  it("rejects a malformed timestamp", () => {
    expect(() => parseCaptions("WEBVTT\n\n00:00:xx.000 --> 00:00:05.000\nhello")).toThrow(IngestError);
    expect(() => parseCaptions("WEBVTT\n\n00:99:00.000 --> 00:99:05.000\nhello")).toThrow(/out of range/);
  });
  it("drops rolling duplicate caption lines", () => {
    const cues = parseCaptions("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhello there\n\n00:00:02.000 --> 00:00:04.000\nhello there\n\n00:00:04.000 --> 00:00:06.000\nhello there friend.");
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("hello there friend.");
  });
  it("forces a cut at the max window", () => {
    const cues = Array.from({ length: 10 }, (_, i) => ({ start: i * 20, end: i * 20 + 20, text: `word${i} and more words` }));
    const chunks = chunkTranscript(cues);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const l = c.locator as { t_start: number; t_end: number };
      expect(l.t_end - l.t_start).toBeLessThanOrEqual(100);
    }
  });
});

describe("slide ingester", () => {
  const ok = { title: "Linked list", bullet_text: "- nodes\n- next pointer", visual_description: "Four boxes joined by arrows ending in NULL.", has_diagram: true, low_information: false };
  it("builds one chunk per slide with the slide locator", () => {
    const chunks = buildSlideChunks([
      { slide: 1, analysis: { ...ok, title: "Intro", bullet_text: "", visual_description: "", has_diagram: false, low_information: true }, assetPath: "s/slide-001.png" },
      { slide: 2, analysis: ok, assetPath: "s/slide-002.png" },
    ]);
    expect(chunks.map((c) => c.locator)).toEqual([{ slide: 1 }, { slide: 2 }]);
    expect(chunks[0].lowInformation).toBe(true);
    expect(chunks[1].visualDescription).toContain("NULL");
    expect(chunks[1].text).toBe("Linked list\n- nodes\n- next pointer");
  });
  it("keeps a diagram-only slide retrievable", () => {
    const [c] = buildSlideChunks([{ slide: 3, analysis: { ...ok, title: "", bullet_text: "" }, assetPath: "x" }]);
    expect(c.text).toBe("");
    expect(c.visualDescription).toBeTruthy();
    expect(c.lowInformation).toBe(false);
  });
  it("rejects an empty slide with a clear error", () => {
    const empty = { title: "", bullet_text: "", visual_description: "", has_diagram: false, low_information: true };
    expect(() => buildSlideChunks([{ slide: 4, analysis: empty, assetPath: "x" }])).toThrow(/slide 4/);
    expect(buildSlideChunks([{ slide: 4, analysis: empty, assetPath: "x" }], { allowEmpty: true })[0].lowInformation).toBe(true);
  });
  it("rejects duplicated slides", () => {
    expect(() => buildSlideChunks([
      { slide: 1, analysis: ok, assetPath: "a" }, { slide: 2, analysis: ok, assetPath: "b" },
    ])).toThrow(/duplicates/);
  });
});

describe("textbook ingester", () => {
  let salt = 0;
  const body = (n: number) => { salt++; return Array.from({ length: n }, (_, i) => `sentence${salt}x${i} about hashing and buckets`).join(" "); };
  const page = (num: number, text: string) => `Data Structures Handbook\n\n${text}\n\n${num}\n`;
  const pages = [
    page(43, `5 Hash tables\n\n${body(40)}`),
    page(44, `5.1 Chained hashing\n\n${body(40)}\n\n${body(40)}`),
    page(45, body(40)),
    page(46, body(40)),
  ];
  it("strips running headers and page numbers", () => {
    const running = findRunningLines(pages);
    const cleaned = cleanPage(pages[1], running);
    expect(cleaned).not.toMatch(/Data Structures Handbook/);
    expect(cleaned.trim().endsWith("44")).toBe(false);
  });
  it("anchors chunks to pages and carries the section heading", () => {
    const chunks = buildTextbookChunks(pages, 43);
    const byPage = (p: number) => chunks.filter((c) => (c.locator as { page: number }).page === p);
    expect(byPage(43).length).toBeGreaterThan(0);
    expect(byPage(44).length).toBeGreaterThan(1);
    expect((byPage(44)[0].locator as { section: string }).section).toBe("5.1 Chained hashing");
    expect((byPage(45)[0].locator as { section: string }).section).toBe("5.1 Chained hashing");
    expect(chunks.every((c) => !/Data Structures Handbook/.test(c.text))).toBe(true);
    expect(chunks.every((c) => c.modality === "page_text")).toBe(true);
  });
});

describe("validateChunks", () => {
  const base: RawChunk = { seq: 0, modality: "transcript", locator: { t_start: 0, t_end: 10 }, heading: null, text: "hello world", visualDescription: null, assetPath: null, lowInformation: false };
  it("rejects bad ranges, empty text and duplicates", () => {
    expect(() => validateChunks([{ ...base, locator: { t_start: 10, t_end: 5 } }])).toThrow(/bad time range/);
    expect(() => validateChunks([{ ...base, text: " " }])).toThrow(/empty/);
    expect(() => validateChunks([base, { ...base, seq: 1, text: "Hello, WORLD!" }])).toThrow(/duplicates chunk 0/);
  });
  it("normalises text for quote matching", () => {
    expect(normalizeText("A  Hash—Function, maps!")).toBe("a hash function maps");
  });
});
