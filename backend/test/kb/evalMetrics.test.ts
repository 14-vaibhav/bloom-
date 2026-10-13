import { describe, expect, it } from "vitest";
import { aggregate, locatorOverlaps, matchesGold, percentile, type GoldQuestion, type PerQuestion } from "../../src/eval/kb/metrics.js";

describe("eval:kb metrics", () => {
  it("overlaps time, slide and page ranges", () => {
    expect(locatorOverlaps({ t_start: 860, t_end: 935 }, { t_start: 900, t_end: 1000 })).toBe(true);
    expect(locatorOverlaps({ t_start: 100, t_end: 200 }, { t_start: 200, t_end: 300 })).toBe(false);
    expect(locatorOverlaps({ slide: 12 }, { slide_start: 12, slide_end: 12 })).toBe(true);
    expect(locatorOverlaps({ slide: 13 }, { slide_start: 12, slide_end: 12 })).toBe(false);
    expect(locatorOverlaps({ page: 44 }, { page_start: 40, page_end: 45 })).toBe(true);
  });
  it("matches the gold source and any acceptable alternative", () => {
    const gold: GoldQuestion = { id: "q", kind: "answerable", question: "?", expected: { source_id: "a", range: { slide_start: 3, slide_end: 3 } }, acceptable: [{ source_id: "b", range: { page_start: 9, page_end: 10 } }] };
    expect(matchesGold({ source_id: "a", locator: { slide: 3 } }, gold)).toBe(true);
    expect(matchesGold({ source_id: "b", locator: { page: 10 } }, gold)).toBe(true);
    expect(matchesGold({ source_id: "b", locator: { slide: 3 } }, gold)).toBe(false);
  });
  it("percentiles and aggregates, treating declined answers separately", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([], 50)).toBeNull();
    const base = { question: "?", retrieval_mode: "hybrid", cited_labels: [], answer_text: "", latency_ms: 100 };
    const rows: PerQuestion[] = [
      { ...base, id: "1", kind: "answerable", outcome: "answered", hit_at_5: true, first_pass_valid: true, shown_valid: true, cross_source: true, cites_expected: true, declined: false },
      { ...base, id: "2", kind: "diagram", outcome: "extractive_fallback", hit_at_5: false, first_pass_valid: false, shown_valid: true, cross_source: false, cites_expected: false, declined: false, latency_ms: 300 },
      { ...base, id: "3", kind: "unanswerable", outcome: "declined_no_evidence", hit_at_5: null, first_pass_valid: null, shown_valid: null, cross_source: null, cites_expected: null, declined: true },
    ];
    const a = aggregate(rows, { "1": true, "2": false });
    expect(a.retrieval_hit_at_5).toMatchObject({ n: 1, of: 2 });
    expect(a.shown_answer_validity).toMatchObject({ n: 2, of: 2 });
    expect(a.correct_refusals).toMatchObject({ n: 1, of: 1 });
    expect(a.diagram_questions_answered).toMatchObject({ n: 0, of: 1 });
    expect(a.faithfulness_hand_graded).toMatchObject({ n: 1, of: 2 });
    expect(a.latency_ms.p95).toBe(300);
  });
});
