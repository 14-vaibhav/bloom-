/**
 * Tutor personalisation (v4 §N4.2): code decides the mode and the citation order; the LLM only writes
 * the words. Reads beliefs, never writes them (v3 §8: "the LLM cannot assign numbers").
 */
import type { KbChunk } from "../kb/retrieval.js";
import type { TutorMode } from "./citationValidator.js";

export const EXPLAIN_BELOW_MU = 0.35;
export const WEAK_PREREQ_MU = 0.6;
export const DEFAULT_TARGET = 0.75;

export function chooseMode(input: { mu: number | null; target: number; prereqMus: number[] }): TutorMode {
  if (input.mu === null) return "explain"; // no belief yet: start from the basics
  if (input.mu < EXPLAIN_BELOW_MU || input.prereqMus.some((m) => m < WEAK_PREREQ_MU)) return "explain";
  if (input.mu >= input.target) return "challenge";
  return "connect";
}

/** format_efficacy is keyed by resource type; slides sit between lecture and reading. */
export function kindPreference(kind: KbChunk["kind"], efficacy: Record<string, number>): number {
  const video = efficacy.video ?? 0.1;
  const article = efficacy.article ?? 0.1;
  if (kind === "video") return video;
  if (kind === "textbook") return article;
  return (video + article) / 2;
}

/** Orders chunks by the student's measured format efficacy (stable within a kind, by retrieval score). In `explain` mode lecture and slide chunks are preferred. */
export function orderByEfficacy<T extends Pick<KbChunk, "kind" | "score">>(chunks: T[], efficacy: Record<string, number>, mode: TutorMode): T[] {
  const bonus = (c: T) => (mode === "explain" && c.kind !== "textbook" ? 0.05 : 0);
  return [...chunks].sort((a, b) => {
    const pa = kindPreference(a.kind, efficacy) + bonus(a);
    const pb = kindPreference(b.kind, efficacy) + bonus(b);
    return pb - pa || b.score - a.score;
  });
}

/** Subtopics a retrieval touches, most-voted first. Weighted by rank so the best chunk counts most. */
export function voteSubtopics(chunks: Array<{ subtopic_ids: string[] }>, limit = 3): string[] {
  const votes = new Map<string, number>();
  chunks.forEach((c, i) => c.subtopic_ids.forEach((s) => votes.set(s, (votes.get(s) ?? 0) + 1 / (i + 1))));
  return [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([s]) => s);
}
