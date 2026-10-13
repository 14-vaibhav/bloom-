/** Pure metric functions for eval:kb (v4 §N7.2). Numbers are measured, never targeted. */
export type Range = { t_start?: number; t_end?: number; slide_start?: number; slide_end?: number; page_start?: number; page_end?: number };
export type Expected = { source_id: string; range: Range };
export type GoldQuestion = { id: string; kind: "answerable" | "diagram" | "unanswerable"; question: string; expected?: Expected; acceptable?: Expected[] };

export function locatorOverlaps(locator: Record<string, unknown>, range: Range): boolean {
  if (range.t_start !== undefined && range.t_end !== undefined) {
    return Number(locator.t_start) < range.t_end && Number(locator.t_end) > range.t_start;
  }
  if (range.slide_start !== undefined && range.slide_end !== undefined) {
    const s = Number(locator.slide);
    return s >= range.slide_start && s <= range.slide_end;
  }
  if (range.page_start !== undefined && range.page_end !== undefined) {
    const p = Number(locator.page);
    return p >= range.page_start && p <= range.page_end;
  }
  return false;
}

export function matchesGold(chunk: { source_id: string; locator: Record<string, unknown> }, gold: GoldQuestion): boolean {
  return [gold.expected, ...(gold.acceptable ?? [])].some((e) => e && e.source_id === chunk.source_id && locatorOverlaps(chunk.locator, e.range));
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export type PerQuestion = {
  id: string; kind: GoldQuestion["kind"]; question: string; outcome: string; retrieval_mode: string | null;
  hit_at_5: boolean | null; first_pass_valid: boolean | null; shown_valid: boolean | null; cross_source: boolean | null;
  cites_expected: boolean | null; declined: boolean; latency_ms: number; cited_labels: string[]; answer_text: string;
};

const frac = (num: number, den: number) => (den === 0 ? null : { n: num, of: den, rate: num / den });

export function aggregate(rows: PerQuestion[], grades: Record<string, boolean>) {
  const answerable = rows.filter((r) => r.kind !== "unanswerable");
  const shown = rows.filter((r) => !r.declined);
  const diagram = rows.filter((r) => r.kind === "diagram");
  const unanswerable = rows.filter((r) => r.kind === "unanswerable");
  const graded = shown.filter((r) => r.id in grades);
  return {
    questions: rows.length,
    retrieval_hit_at_5: frac(answerable.filter((r) => r.hit_at_5).length, answerable.length),
    first_pass_citation_validity: frac(answerable.filter((r) => r.first_pass_valid).length, answerable.length),
    shown_answer_validity: frac(shown.filter((r) => r.shown_valid).length, shown.length),
    cross_source_rate: frac(shown.filter((r) => r.cross_source).length, shown.length),
    diagram_questions_answered: frac(diagram.filter((r) => r.cites_expected).length, diagram.length),
    correct_refusals: frac(unanswerable.filter((r) => r.declined).length, unanswerable.length),
    faithfulness_hand_graded: frac(graded.filter((r) => grades[r.id]).length, graded.length),
    latency_ms: { p50: percentile(rows.map((r) => r.latency_ms), 50), p95: percentile(rows.map((r) => r.latency_ms), 95) },
  };
}
export type Aggregate = ReturnType<typeof aggregate>;

const pct = (f: { n: number; of: number; rate: number } | null) => (f ? `${(f.rate * 100).toFixed(0)}% (${f.n}/${f.of})` : "n/a");

export function renderReport(a: Aggregate, rows: PerQuestion[], meta: { at: string; llm: boolean; gold: number }): string {
  const lines = [
    "# Knowledge-base evaluation",
    "",
    `Run ${meta.at} · ${meta.gold} gold questions · tutor LLM ${meta.llm ? "on" : "OFF (extractive answers only)"}.`,
    "Numbers below are what was measured on this run; no targets were set beforehand.",
    "",
    "| Metric | Result |", "|---|---|",
    `| Retrieval hit@5 | ${pct(a.retrieval_hit_at_5)} |`,
    `| First-pass citation validity (K1–K4, no repair) | ${pct(a.first_pass_citation_validity)} |`,
    `| Shown-answer validity (must be 100% by construction) | ${pct(a.shown_answer_validity)} |`,
    `| Cross-source rate (≥2 source kinds cited) | ${pct(a.cross_source_rate)} |`,
    `| Diagram questions answered (cite the right slide) | ${pct(a.diagram_questions_answered)} |`,
    `| Correct refusals (unanswerable → declined) | ${pct(a.correct_refusals)} |`,
    `| Faithfulness (hand-graded) | ${pct(a.faithfulness_hand_graded)} |`,
    `| Latency p50 / p95 | ${a.latency_ms.p50 ?? "n/a"} ms / ${a.latency_ms.p95 ?? "n/a"} ms |`,
    "",
    "K3 proves a citation points at real text the model was shown. It does not prove the paraphrase is faithful — that is the hand-graded row, graded by reading each shown answer against its cited passage.",
    "",
    "## Per question", "",
    "| id | kind | outcome | hit@5 | first-pass | cites expected |", "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.kind} | ${r.outcome} | ${r.hit_at_5 ?? "–"} | ${r.first_pass_valid ?? "–"} | ${r.cites_expected ?? "–"} |`),
    "",
  ];
  return lines.join("\n");
}
