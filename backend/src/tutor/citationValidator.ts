/**
 * Citation validator (v4 §N4.3) — a pure function, same pattern as core/validator.ts.
 * It gates every tutor answer before display.
 *
 *   K1 every segment cites ≥1 chunk                         hard
 *   K2 every cited chunk was in this turn's retrieved set   hard
 *   K3 the quote (6–30 words) is a normalised substring of  hard
 *      one of the segment's cited chunks
 *   K4 every locator resolves (source exists, timestamp ≤   hard
 *      duration, page ≤ page count, slide asset on disk)
 *   K5 ≥2 source kinds cited when the retrieved set had 2   soft
 *   K6 answer length within the bounds for the mode         soft
 *
 * K3 proves the citation points at real text the model was shown. It does NOT prove the
 * paraphrase is faithful — the hand-graded number in eval:kb measures that.
 */
import { normalizeText, wordCount } from "../kb/ingest/types.js";
import type { KbChunk } from "../kb/retrieval.js";

export type TutorMode = "explain" | "connect" | "challenge";
export type Segment = { text: string; chunk_ids: string[]; quote: string };
export type TutorAnswer = { segments: Segment[]; follow_up?: string | null };

export type SourceInfo = { kind: "video" | "slides" | "textbook"; duration_sec: number | null; unit_count: number | null };

export type CheckId = "K1" | "K2" | "K3" | "K4" | "K5" | "K6";
export type CheckResult = { id: CheckId; severity: "hard" | "soft"; passed: boolean; detail: string };
export type ValidationReport = { passed: boolean; checks: CheckResult[]; hard_failures: string[]; soft_warnings: string[] };

export const QUOTE_MIN_WORDS = 6;
export const QUOTE_MAX_WORDS = 30;
export const LENGTH_BOUNDS: Record<TutorMode, [number, number]> = { explain: [50, 260], connect: [30, 200], challenge: [15, 130] };

export type ValidatorInput = {
  answer: TutorAnswer;
  retrieved: KbChunk[];
  mode: TutorMode;
  sources: Map<string, SourceInfo>;
  /** relative path under kb-assets → exists on disk? */
  assetExists: (assetPath: string) => boolean;
};

function chunkHaystack(c: KbChunk): string {
  return normalizeText(`${c.text} ${c.visual_description ?? ""}`);
}

export function locatorResolves(c: KbChunk, sources: Map<string, SourceInfo>, assetExists: (p: string) => boolean): string | null {
  const src = sources.get(c.source_id);
  if (!src) return `source ${c.source_id} does not exist`;
  const loc = c.locator as Record<string, unknown>;
  if (src.kind === "video") {
    const t = Number(loc.t_start);
    if (!Number.isFinite(t) || t < 0) return `bad timestamp for ${c.chunk_id}`;
    if (src.duration_sec !== null && t > src.duration_sec) return `timestamp ${t}s is beyond the ${src.duration_sec}s video (${c.chunk_id})`;
  } else if (src.kind === "textbook") {
    const p = Number(loc.page);
    if (!Number.isInteger(p) || p < 1) return `bad page for ${c.chunk_id}`;
    if (src.unit_count !== null && p > src.unit_count) return `page ${p} is beyond the ${src.unit_count}-page book (${c.chunk_id})`;
  } else {
    const n = Number(loc.slide);
    if (!Number.isInteger(n) || n < 1) return `bad slide number for ${c.chunk_id}`;
    if (src.unit_count !== null && n > src.unit_count) return `slide ${n} is beyond the ${src.unit_count}-slide deck (${c.chunk_id})`;
    const assetPath = c.asset_url?.replace(/^\/kb-assets\//, "");
    if (!assetPath || !assetExists(assetPath)) return `slide image for ${c.chunk_id} is missing on disk`;
  }
  return null;
}

export function validateCitations(input: ValidatorInput): ValidationReport {
  const { answer, retrieved, mode, sources, assetExists } = input;
  const byId = new Map(retrieved.map((c) => [c.chunk_id, c]));
  const checks: CheckResult[] = [];
  const hard: string[] = [];
  const soft: string[] = [];

  const fail = (id: CheckId, severity: "hard" | "soft", detail: string) => {
    checks.push({ id, severity, passed: false, detail });
    (severity === "hard" ? hard : soft).push(`${id}: ${detail}`);
  };
  const pass = (id: CheckId, severity: "hard" | "soft", detail: string) => checks.push({ id, severity, passed: true, detail });

  const segs = answer.segments;

  // K1
  const uncited = segs.map((s, i) => (s.chunk_ids.length === 0 ? i : -1)).filter((i) => i >= 0);
  if (segs.length === 0) fail("K1", "hard", "the answer has no segments");
  else if (uncited.length) fail("K1", "hard", `segment ${uncited.map((i) => i + 1).join(", ")} cites no source`);
  else pass("K1", "hard", `${segs.length} segment(s), all cited`);

  // K2
  const invented = [...new Set(segs.flatMap((s) => s.chunk_ids).filter((id) => !byId.has(id)))];
  if (invented.length) fail("K2", "hard", `cited chunk(s) not in the retrieved set: ${invented.join(", ")}`);
  else pass("K2", "hard", "every cited chunk was retrieved this turn");

  // K3
  const k3: string[] = [];
  segs.forEach((s, i) => {
    const words = wordCount(s.quote);
    if (words < QUOTE_MIN_WORDS || words > QUOTE_MAX_WORDS) {
      k3.push(`segment ${i + 1}: quote has ${words} words (needs ${QUOTE_MIN_WORDS}–${QUOTE_MAX_WORDS})`);
      return;
    }
    const q = normalizeText(s.quote);
    const ok = s.chunk_ids.some((id) => {
      const c = byId.get(id);
      return c ? chunkHaystack(c).includes(q) : false;
    });
    if (!ok) k3.push(`segment ${i + 1}: quote is not found in any cited chunk`);
  });
  if (k3.length) fail("K3", "hard", k3.join("; "));
  else pass("K3", "hard", "every quote appears in a cited chunk");

  // K4
  const cited = [...new Set(segs.flatMap((s) => s.chunk_ids))].map((id) => byId.get(id)).filter((c): c is KbChunk => !!c);
  const k4 = cited.map((c) => locatorResolves(c, sources, assetExists)).filter((m): m is string => !!m);
  if (k4.length) fail("K4", "hard", k4.join("; "));
  else pass("K4", "hard", `${cited.length} locator(s) resolve`);

  // K5
  const offered = new Set(retrieved.map((c) => c.kind));
  const citedKinds = new Set(cited.map((c) => c.kind));
  if (offered.size >= 2 && citedKinds.size < 2) soft.push("K5: only one source kind cited although the retrieved set offered " + [...offered].join(", ")), checks.push({ id: "K5", severity: "soft", passed: false, detail: `cites ${[...citedKinds].join(", ") || "nothing"}; offered ${[...offered].join(", ")}` });
  else pass("K5", "soft", `${citedKinds.size} source kind(s) cited`);

  // K6
  const words = segs.reduce((n, s) => n + wordCount(s.text), 0);
  const [lo, hi] = LENGTH_BOUNDS[mode];
  if (words < lo || words > hi) fail("K6", "soft", `${words} words, expected ${lo}–${hi} for mode ${mode}`);
  else pass("K6", "soft", `${words} words`);

  return { passed: hard.length === 0, checks, hard_failures: hard, soft_warnings: soft };
}

/** Text for the one repair round: what failed and why. */
export function repairInstructions(report: ValidationReport): string[] {
  return report.hard_failures;
}
