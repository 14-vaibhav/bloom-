import { describe, expect, it } from "vitest";
import { extractiveAnswer } from "../../src/tutor/extractive.js";
import { validateCitations, type SourceInfo, type TutorAnswer, type ValidatorInput } from "../../src/tutor/citationValidator.js";
import { chooseMode, orderByEfficacy, voteSubtopics } from "../../src/tutor/mode.js";
import type { KbChunk } from "../../src/kb/retrieval.js";

const chunk = (id: string, kind: KbChunk["kind"], text: string, extra: Partial<KbChunk> = {}): KbChunk => ({
  chunk_id: id, source_id: `src_${kind}`, source_title: "T", kind, modality: "x",
  locator: kind === "video" ? { t_start: 860, t_end: 900 } : kind === "slides" ? { slide: 12 } : { page: 44 },
  label: `T · ${id}`, deep_link: "", asset_url: kind === "slides" ? "/kb-assets/src_slides/slide-012.png" : null,
  text, visual_description: null, subtopic_ids: [], score: 0.02, ...extra,
});

const retrieved = [
  chunk("v:1", "video", "A singly linked list stores each element in a node and every node holds a pointer to the next node in the list."),
  chunk("s:1", "slides", "", { visual_description: "Four boxes joined by arrows and the last arrow points to NULL at the end of the list." }),
  chunk("b:1", "textbook", "A stack supports push and pop operations on one end following last in first out order of the elements."),
];
const sources = new Map<string, SourceInfo>([
  ["src_video", { kind: "video", duration_sec: 3000, unit_count: null }],
  ["src_slides", { kind: "slides", duration_sec: null, unit_count: 40 }],
  ["src_textbook", { kind: "textbook", duration_sec: null, unit_count: 300 }],
]);
const base = (answer: TutorAnswer, over: Partial<ValidatorInput> = {}): ValidatorInput => ({
  answer, retrieved, mode: "connect", sources, assetExists: () => true, ...over,
});
const good: TutorAnswer = {
  segments: [
    { text: "A linked list keeps its elements in nodes, and each node points at the next one. ".repeat(3), chunk_ids: ["v:1", "s:1"], quote: "every node holds a pointer to the next node in the list" },
    { text: "The last arrow points to NULL which marks the end of the whole list.", chunk_ids: ["s:1"], quote: "the last arrow points to NULL at the end" },
  ],
};
const failed = (r: ReturnType<typeof validateCitations>, id: string) => r.checks.find((c) => c.id === id && !c.passed);

describe("citation validator", () => {
  it("passes a well-formed, grounded answer", () => {
    const r = validateCitations(base(good));
    expect(r.hard_failures).toEqual([]);
    expect(r.passed).toBe(true);
  });
  it("K1 rejects a segment with no citation", () => {
    const r = validateCitations(base({ segments: [{ ...good.segments[0], chunk_ids: [] }] }));
    expect(failed(r, "K1")).toBeTruthy();
    expect(r.passed).toBe(false);
  });
  it("K1 rejects an empty answer", () => {
    expect(failed(validateCitations(base({ segments: [] })), "K1")).toBeTruthy();
  });
  it("K2 rejects an invented source", () => {
    const r = validateCitations(base({ segments: [{ ...good.segments[0], chunk_ids: ["v:1", "invented:999"] }] }));
    expect(failed(r, "K2")?.detail).toContain("invented:999");
    expect(r.passed).toBe(false);
  });
  it("K3 rejects a quote that is not in the cited chunk", () => {
    const r = validateCitations(base({ segments: [{ ...good.segments[0], quote: "this sentence never appeared in any retrieved passage at all" }] }));
    expect(failed(r, "K3")).toBeTruthy();
  });
  it("K3 rejects a quote found only in a chunk the segment did not cite", () => {
    const r = validateCitations(base({ segments: [{ ...good.segments[0], chunk_ids: ["v:1"], quote: "the last arrow points to NULL at the end" }] }));
    expect(failed(r, "K3")).toBeTruthy();
  });
  it("K3 rejects quotes outside 6–30 words", () => {
    const short = validateCitations(base({ segments: [{ ...good.segments[0], quote: "node holds a pointer" }] }));
    expect(failed(short, "K3")?.detail).toContain("needs 6–30");
  });
  it("K3 tolerates case and punctuation differences", () => {
    const r = validateCitations(base({ segments: [{ ...good.segments[0], quote: "Every node holds a POINTER to the next node, in the list!" }] }));
    expect(failed(r, "K3")).toBeUndefined();
  });
  it("K4 rejects a timestamp beyond the video", () => {
    const r = validateCitations(base(good, { retrieved: [chunk("v:1", "video", retrieved[0].text, { locator: { t_start: 9999, t_end: 10050 } }), ...retrieved.slice(1)] }));
    expect(failed(r, "K4")?.detail).toContain("beyond");
  });
  it("K4 rejects a page beyond the book", () => {
    const r = validateCitations(base({ segments: [{ text: "x ".repeat(40), chunk_ids: ["b:1"], quote: "supports push and pop operations on one end following last in first out" }] }, { retrieved: [chunk("b:1", "textbook", retrieved[2].text, { locator: { page: 999 } })] }));
    expect(failed(r, "K4")?.detail).toContain("beyond");
  });
  it("K4 rejects a slide whose image is missing, and an unknown source", () => {
    expect(failed(validateCitations(base(good, { assetExists: () => false })), "K4")?.detail).toContain("missing");
    expect(failed(validateCitations(base(good, { sources: new Map() })), "K4")?.detail).toContain("does not exist");
  });
  it("K5 warns (soft) when only one kind is cited although more were offered", () => {
    const r = validateCitations(base({ segments: [good.segments[0]].map((s) => ({ ...s, chunk_ids: ["v:1"] })) }));
    expect(r.passed).toBe(true);
    expect(r.soft_warnings.some((w) => w.startsWith("K5"))).toBe(true);
  });
  it("K6 warns (soft) on length", () => {
    const r = validateCitations(base({ segments: [{ ...good.segments[1], chunk_ids: ["s:1", "v:1"] }] }, { mode: "explain" }));
    expect(r.soft_warnings.some((w) => w.startsWith("K6"))).toBe(true);
    expect(r.passed).toBe(true);
  });
});

describe("extractive fallback", () => {
  it("passes K1–K4 by construction and covers each kind", () => {
    const ex = extractiveAnswer(retrieved);
    expect(ex.segments.length).toBe(3);
    const r = validateCitations(base(ex));
    expect(r.hard_failures).toEqual([]);
    expect(new Set(ex.segments.flatMap((s) => s.chunk_ids))).toEqual(new Set(["v:1", "s:1", "b:1"]));
  });
});

describe("personalisation (pure)", () => {
  it("chooses the mode from mu, target and prerequisites", () => {
    expect(chooseMode({ mu: 0.2, target: 0.75, prereqMus: [] })).toBe("explain");
    expect(chooseMode({ mu: 0.6, target: 0.75, prereqMus: [0.4] })).toBe("explain");
    expect(chooseMode({ mu: 0.5, target: 0.75, prereqMus: [0.9] })).toBe("connect");
    expect(chooseMode({ mu: 0.8, target: 0.75, prereqMus: [0.9] })).toBe("challenge");
    expect(chooseMode({ mu: null, target: 0.75, prereqMus: [] })).toBe("explain");
  });
  it("orders citations by the student's measured format efficacy", () => {
    const videoFirst = orderByEfficacy(retrieved, { video: 0.4, article: 0.1 }, "connect").map((c) => c.kind);
    expect(videoFirst[0]).toBe("video");
    const bookFirst = orderByEfficacy(retrieved, { video: 0.05, article: 0.4 }, "connect").map((c) => c.kind);
    expect(bookFirst[0]).toBe("textbook");
  });
  it("votes subtopics by rank-weighted tags", () => {
    expect(voteSubtopics([{ subtopic_ids: ["a"] }, { subtopic_ids: ["b"] }, { subtopic_ids: ["b"] }, { subtopic_ids: ["b"] }])).toEqual(["b", "a"]);
  });
});
