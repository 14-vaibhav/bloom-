import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { sourceChunks, sources } from "../../src/db/schema.js";
import { diversify, queryTerms, rrf, searchCourseContent } from "../../src/kb/retrieval.js";
import { storeSource } from "../../src/kb/ingest/store.js";
import { callTool } from "../../src/tools/dispatcher.js";
import { createUntrackedContext } from "../../src/tools/context.js";
import { dispatchWithResilience } from "../../src/tools/dispatcher.js";
import { ToolUnavailableError, TransientError } from "../../src/tools/errors.js";
import { getDemoStudentId, resetToolHealth } from "../tools/helpers.js";
import { BOOK, cleanFakeKb, fakeEmbedQuery, seedFakeKb, SLIDES, VIDEO } from "./helpers.js";
import { toolHealth } from "../../src/db/schema.js";

beforeAll(async () => { await seedFakeKb(); await resetToolHealth("kb"); });
afterAll(async () => { await cleanFakeKb(); await resetToolHealth("kb"); });

describe("search_course_content", () => {
  it("returns chunks from all three kinds with exact labels and deep links", async () => {
    const r = await searchCourseContent({ query: "how does a singly linked list store the next pointer in each node", embedQuery: fakeEmbedQuery, evidenceSim: 0.2 });
    expect(r.retrieval_mode).toBe("hybrid");
    const kinds = new Set(r.chunks.map((c) => c.kind));
    expect(kinds).toEqual(new Set(["video", "slides", "textbook"]));
    const video = r.chunks.find((c) => c.kind === "video")!;
    expect(video.label).toBe("Lecture 5 · 14:20");
    expect(video.deep_link).toBe("https://www.youtube.com/watch?v=abcdefghijk&t=860s");
    const slide = r.chunks.find((c) => c.kind === "slides")!;
    expect(slide.label).toBe("Slides wk5 · slide 11");
    expect(slide.asset_url).toBe(`/kb-assets/${SLIDES}/slide-011.png`);
    const book = r.chunks.find((c) => c.kind === "textbook")!;
    expect(book.label).toBe("ODS · p. 44");
    expect(book.deep_link).toBe("https://example.org/ods.pdf#page=44");
  });

  it("retrieves a diagram-only slide through its vision description", async () => {
    const r = await searchCourseContent({ query: "vertical pile of plates where push adds on top", embedQuery: fakeEmbedQuery, evidenceSim: 0.2 });
    expect(r.chunks[0].chunk_id).toBe(`${SLIDES}:1`);
    expect(r.chunks[0].text).toBe("");
  });

  it("never returns low-information slides", async () => {
    const r = await searchCourseContent({ query: "week 5 data structures", embedQuery: fakeEmbedQuery, evidenceSim: 0 });
    expect([...r.chunks, ...r.nearest].some((c) => c.chunk_id === `${SLIDES}:2`)).toBe(false);
  });

  it("falls back to lexical retrieval when the embedding call fails", async () => {
    const r = await searchCourseContent({ query: "reverse a linked list by flipping next pointers", embedQuery: async () => { throw new Error("boom"); } });
    expect(r.retrieval_mode).toBe("lexical");
    expect(r.notices).toContain("Embedding unavailable — lexical retrieval used.");
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.chunks[0].chunk_id).toBe(`${VIDEO}:1`);
  });

  it("returns no chunks but fills nearest when there is no evidence", async () => {
    const r = await searchCourseContent({ query: "quantum chromodynamics gluon confinement", embedQuery: fakeEmbedQuery, evidenceSim: 0.5 });
    expect(r.chunks).toEqual([]);
    const lexical = await searchCourseContent({ query: "quantum chromodynamics gluon confinement", embedQuery: async () => { throw new Error("x"); } });
    expect(lexical.chunks).toEqual([]);
  });

  it("filters by kind", async () => {
    const r = await searchCourseContent({ query: "linked list node pointer", kinds: ["textbook"], embedQuery: fakeEmbedQuery, evidenceSim: 0.1 });
    expect(r.chunks.every((c) => c.kind === "textbook")).toBe(true);
    expect(r.chunks[0].chunk_id).toBe(`${BOOK}:0`);
  });
});

describe("fusion helpers", () => {
  const row = (id: string, kind: "video" | "slides" | "textbook") => ({ id, source_id: "s", source_title: "t", source_url: null, kind, modality: "x", locator: {}, text: id, visual_description: null, asset_path: null, subtopic_ids: [] });
  it("rrf rewards agreement between the two lists", () => {
    const fused = rrf([[row("a", "video"), row("b", "video")], [row("b", "video"), row("c", "video")]]);
    expect(fused[0].row.id).toBe("b");
  });
  it("diversify swaps in the best chunk of a missing kind when close enough", () => {
    const items = [...Array.from({ length: 8 }, (_, i) => ({ row: row(`v${i}`, "video"), score: 0.03 - i * 0.0005 })), { row: row("book", "textbook"), score: 0.0265 }];
    const top = diversify(items, 8, 0.004);
    expect(top.some((t) => t.row.id === "book")).toBe(true);
    expect(top).toHaveLength(8);
    const far = diversify([...items.slice(0, 8), { row: row("book", "textbook"), score: 0.001 }], 8, 0.004);
    expect(far.some((t) => t.row.id === "book")).toBe(false);
  });
  it("drops stopwords from query terms", () => {
    expect(queryTerms("What is the difference between a stack and a queue?")).toEqual(["stack", "queue"]);
  });
});

describe("tool 6 through the dispatcher", () => {
  it("exercises all three ops with an untracked context (no agent_runs row)", async () => {
    const ctx = createUntrackedContext({ studentId: await getDemoStudentId() });
    process.env.KB_FORCE_EMBED_FAIL = "true";
    try {
      const found = await callTool(ctx, "kb.search_course_content", { query: "reverse a linked list", k: 8 });
      expect(found.retrieval_mode).toBe("lexical");
      const chunk = await callTool(ctx, "kb.get_chunk", { chunk_id: `${VIDEO}:1` });
      expect(chunk.neighbours).toEqual({ prev_id: `${VIDEO}:0`, next_id: `${VIDEO}:2` });
      const outline = await callTool(ctx, "kb.get_source_outline", { source_id: BOOK });
      expect(outline.source.chunk_count).toBe(2);
      expect(outline.units[0].locator).toEqual({ page: 44, section: "3.1 Singly linked lists" });
    } finally {
      delete process.env.KB_FORCE_EMBED_FAIL;
    }
  });

  it("opens the breaker after repeated transient failures, then fails fast", async () => {
    const ctx = createUntrackedContext({ studentId: await getDemoStudentId() });
    const failing = async () => { throw new TransientError("kb down"); };
    for (let i = 0; i < 3; i++) await expect(dispatchWithResilience(ctx, "kb", "search_course_content", {}, failing)).rejects.toThrow("kb down");
    const [h] = await db.select().from(toolHealth).where(eq(toolHealth.toolName, "kb"));
    expect(h.state).toBe("open");
    await expect(callTool(ctx, "kb.search_course_content", { query: "linked list", k: 8 })).rejects.toBeInstanceOf(ToolUnavailableError);
    await resetToolHealth("kb");
  }, 30000);
});

describe("ingest idempotency", () => {
  it("re-ingesting unchanged content is a no-op; changed content replaces the chunks", async () => {
    const meta = { id: `${VIDEO}_idem`, subjectId: "dsa", kind: "video" as const, title: "Idem" };
    const c = [{ seq: 0, modality: "transcript" as const, locator: { t_start: 0, t_end: 10 }, heading: null, text: "alpha beta gamma", visualDescription: null, assetPath: null, lowInformation: false }];
    expect((await storeSource(meta, c)).status).toBe("ingested");
    expect((await storeSource(meta, c)).status).toBe("unchanged");
    expect((await storeSource(meta, [{ ...c[0], text: "delta epsilon" }])).status).toBe("ingested");
    const rows = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, meta.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("delta epsilon");
    expect(rows[0].tsv).toBeTruthy();
    await db.delete(sources).where(eq(sources.id, meta.id));
  });
});
