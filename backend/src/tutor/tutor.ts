/**
 * The cited tutor (v4 §N4). Pipeline: RETRIEVE → RESOLVE → PERSONALISE → ANSWER → VALIDATE → REPAIR → RECORD.
 *
 * Differences from the plan's step order, on purpose:
 *  - RESOLVE reads the subtopic tags of the retrieved chunks (rank-weighted vote) instead of embedding the
 *    question against every subtopic: one runtime embedding call, not two, and a lexical-only turn still resolves.
 *  - The "observation" the agent loop sees is the tutor_turns row itself (agent/observe.ts reads it). The
 *    state.append_observation tool needs an agent_runs row, and §N3.2 forbids inventing runs for tutor turns.
 *
 * Writes only tutor_sessions / tutor_turns. Never touches plans, activities or mastery.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { concepts, learningGoals, questionAttempts, questions, sources, subtopicPrerequisites, tutorSessions, tutorTurns } from "../db/schema.js";
import { getSimNow } from "../agent/simClock.js";
import { KbLlmUnavailableError, kbComplete, llmEnabled } from "../agent/llm/kb.js";
import { ASSET_ROOT } from "../kb/ingest/run.js";
import type { KbChunk } from "../kb/retrieval.js";
import { createUntrackedContext } from "../tools/context.js";
import { callTool } from "../tools/dispatcher.js";
import { ToolUnavailableError } from "../tools/errors.js";
import type { ToolOutput } from "../tools/schemas.js";
import { consumeBreakCitation } from "./breakCitation.js";
import { validateCitations, type SourceInfo, type TutorAnswer, type TutorMode, type ValidationReport } from "./citationValidator.js";
import { extractiveAnswer } from "./extractive.js";
import { chooseMode, DEFAULT_TARGET, orderByEfficacy, voteSubtopics } from "./mode.js";

export type TutorOutcome = "answered" | "extractive_fallback" | "declined_no_evidence" | "declined_kb_down";

export const TutorAnswerSchema = z.object({
  segments: z.array(z.object({ text: z.string(), chunk_ids: z.array(z.string()), quote: z.string() })),
  follow_up: z.string().nullable().optional(),
});

export type TutorTurnResult = {
  turn_id: string;
  session_id: string;
  asked_at: string;
  question: string;
  outcome: TutorOutcome;
  mode: TutorMode | null;
  retrieval_mode: "hybrid" | "lexical" | null;
  subtopic_ids: string[];
  /** Chunks the answer may cite (and the chips the UI can render), in the student's preferred order. */
  chunks: KbChunk[];
  answer: (TutorAnswer & { follow_up_question_id?: string | null }) | null;
  /** Shown instead of an answer when declined. */
  message: string | null;
  nearest: KbChunk[];
  validation: ValidationReport | null;
  repair_rounds: number;
  notices: string[];
  latency_ms: number;
};

export type TutorDeps = {
  /** Replaces the LLM call in tests. Receives the prompt input; returns the raw answer. */
  generate?: (input: AnswerPromptInput) => Promise<TutorAnswer>;
  assetExists?: (p: string) => boolean;
  /** false = read-only run (eval:kb): nothing is written, no session or turn row is created. */
  record?: boolean;
};

type AnswerPromptInput = {
  question: string; mode: TutorMode; length_hint: string; weak_concept?: string;
  passages: Array<{ chunk_id: string; label: string; kind: string; text: string; visual_description: string | null }>;
  prior_failures?: string[];
};

const LENGTH_HINT: Record<TutorMode, string> = {
  explain: "60–200 words, simple wording, start from the prerequisite idea",
  connect: "40–150 words, direct answer",
  challenge: "at most two short segments (under 100 words total)",
};

async function llmAnswer(input: AnswerPromptInput): Promise<TutorAnswer> {
  const { value } = await kbComplete({ agent: "tutor_answer", user: input, schema: TutorAnswerSchema, maxTokens: 1500 });
  return { segments: value.segments, follow_up: value.follow_up ?? null };
}

async function activeTarget(studentId: string, subtopicId: string): Promise<{ subjectId: string | null; target: number }> {
  const [goal] = await db.select().from(learningGoals).where(and(eq(learningGoals.studentId, studentId), eq(learningGoals.status, "active")));
  const t = (goal?.targetMastery as Record<string, number> | undefined)?.[subtopicId];
  return { subjectId: goal?.subjectId ?? null, target: typeof t === "number" ? t : DEFAULT_TARGET };
}

async function lastWrongConcept(studentId: string, subtopicId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: concepts.name })
    .from(questionAttempts)
    .innerJoin(questions, eq(questions.id, questionAttempts.questionId))
    .innerJoin(concepts, eq(concepts.id, questions.conceptId))
    .where(and(eq(questionAttempts.studentId, studentId), eq(questionAttempts.correct, false), eq(questions.subtopicId, subtopicId)))
    .orderBy(desc(questionAttempts.createdAt))
    .limit(1);
  return row?.name ?? null;
}

async function sourceInfoFor(chunks: KbChunk[]): Promise<Map<string, SourceInfo>> {
  const ids = [...new Set(chunks.map((c) => c.source_id))];
  const map = new Map<string, SourceInfo>();
  if (!ids.length) return map;
  const rows = await db.select().from(sources).where(inArray(sources.id, ids));
  for (const r of rows) map.set(r.id, { kind: r.kind, duration_sec: r.durationSec, unit_count: r.unitCount });
  return map;
}

function reorderCitations(answer: TutorAnswer, ordered: KbChunk[]): TutorAnswer {
  const rank = new Map(ordered.map((c, i) => [c.chunk_id, i]));
  return { ...answer, segments: answer.segments.map((s) => ({ ...s, chunk_ids: [...s.chunk_ids].sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99)) })) };
}

export async function askTutor(opts: {
  studentId: string;
  question: string;
  sessionId?: string;
  contextQuestionId?: string;
  contextAssessmentId?: string;
  deps?: TutorDeps;
}): Promise<TutorTurnResult> {
  const started = Date.now();
  const deps = opts.deps ?? {};
  const question = opts.question.trim();
  const trace: Array<{ step: string; detail: string; ms: number }> = [];
  const mark = (step: string, detail: string, t0: number) => trace.push({ step, detail, ms: Date.now() - t0 });
  const notices: string[] = [];

  const simNow = await getSimNow(opts.studentId);
  const ctx = createUntrackedContext({ studentId: opts.studentId, clock: () => new Date() });

  // Context from an assessment question: its subtopic seeds retrieval and the answer mode.
  let contextSubtopic: string | null = null;
  let contextText = "";
  if (opts.contextQuestionId) {
    const [q] = await db.select().from(questions).where(eq(questions.id, opts.contextQuestionId));
    if (q) { contextSubtopic = q.subtopicId; contextText = ` ${q.stem}`; }
  }

  // ── RETRIEVE ────────────────────────────────────────────────
  let t0 = Date.now();
  let retrieval: ToolOutput<"kb.search_course_content"> | null = null;
  let kbDown = false;
  try {
    retrieval = await callTool(ctx, "kb.search_course_content", {
      query: `${question}${contextText}`.slice(0, 500),
      subtopic_ids: contextSubtopic ? [contextSubtopic] : undefined,
      k: 8,
    });
    if (retrieval.retrieval_mode === "lexical") notices.push("Embedding unavailable — lexical retrieval used.");
    mark("retrieve", `${retrieval.retrieval_mode}, ${retrieval.chunks.length} chunks`, t0);
  } catch (err) {
    kbDown = true;
    notices.push(err instanceof ToolUnavailableError ? "Knowledge base unavailable — tutor declined; no uncited answer given." : `Knowledge base error — tutor declined (${(err as Error).message.slice(0, 120)}).`);
    mark("retrieve", "failed", t0);
  }

  // ── RESOLVE ─────────────────────────────────────────────────
  const retrieved = retrieval?.chunks ?? [];
  const voted = voteSubtopics(retrieved.length ? retrieved : retrieval?.nearest ?? []);
  const subtopicIds = contextSubtopic ? [contextSubtopic, ...voted.filter((s) => s !== contextSubtopic)].slice(0, 3) : voted;
  const primary = subtopicIds[0] ?? null;

  // ── PERSONALISE ─────────────────────────────────────────────
  t0 = Date.now();
  let mode: TutorMode = "connect";
  let efficacy: Record<string, number> = {};
  let weakConcept: string | null = null;
  if (primary && !kbDown) {
    try {
      const [perf] = await callTool(ctx, "performance.get_subtopic_performance", { student_id: opts.studentId, subtopic_ids: [primary] });
      const { target } = await activeTarget(opts.studentId, primary);
      const prereqRows = await db.select({ id: subtopicPrerequisites.prereqId }).from(subtopicPrerequisites).where(eq(subtopicPrerequisites.subtopicId, primary));
      const prereqPerf = prereqRows.length ? await callTool(ctx, "performance.get_subtopic_performance", { student_id: opts.studentId, subtopic_ids: prereqRows.map((p) => p.id) }) : [];
      efficacy = perf?.format_efficacy ?? {};
      mode = chooseMode({ mu: perf ? perf.mu : null, target, prereqMus: prereqPerf.map((p) => p.mu) });
      if (mode === "connect") weakConcept = await lastWrongConcept(opts.studentId, primary);
      mark("personalise", `mode=${mode} mu=${perf?.mu ?? "n/a"} target=${target}`, t0);
    } catch (err) {
      notices.push(`Personalisation unavailable (${(err as Error).message.slice(0, 80)}); default mode used.`);
      mark("personalise", "failed", t0);
    }
  }

  // ── ANSWER / VALIDATE / REPAIR ──────────────────────────────
  let outcome: TutorOutcome;
  let answer: TutorTurnResult["answer"] = null;
  let message: string | null = null;
  let validation: ValidationReport | null = null;
  let repairRounds = 0;
  const ordered = orderByEfficacy(retrieved, efficacy, mode);

  if (kbDown) {
    outcome = "declined_kb_down";
    message = "The course knowledge base is unavailable right now, so I can't answer from your material. I won't answer without sources.";
  } else if (retrieved.length === 0) {
    outcome = "declined_no_evidence";
    message = "I can't find this in your course material. The closest passages are listed below.";
  } else {
    const sourceMap = await sourceInfoFor(retrieved);
    const assetExists = deps.assetExists ?? ((p: string) => existsSync(path.join(ASSET_ROOT, p)));
    const check = (a: TutorAnswer) => validateCitations({ answer: a, retrieved, mode, sources: sourceMap, assetExists });
    const passages = ordered.map((c) => ({ chunk_id: c.chunk_id, label: c.label, kind: c.kind, text: c.text, visual_description: c.visual_description }));
    const promptBase: AnswerPromptInput = { question, mode, length_hint: LENGTH_HINT[mode], passages, ...(weakConcept ? { weak_concept: weakConcept } : {}) };
    const generate = deps.generate ?? llmAnswer;

    let candidate: TutorAnswer | null = null;
    let declinedByModel = false;
    if (!llmEnabled() && !deps.generate) {
      notices.push("LLM unavailable — extractive answer returned.");
    } else {
      try {
        t0 = Date.now();
        let attempt = await generate(promptBase);
        mark("answer", `${attempt.segments.length} segments`, t0);
        if (attempt.segments.length === 0) {
          declinedByModel = true;
        } else {
          if (consumeBreakCitation()) {
            attempt = { ...attempt, segments: attempt.segments.map((s, i) => (i === 0 ? { ...s, chunk_ids: [...s.chunk_ids, "invented:999"] } : s)) };
            notices.push("Break citation armed: one invented source was injected into the first attempt.");
          }
          t0 = Date.now();
          validation = check(attempt);
          mark("validate", validation.passed ? "passed" : validation.hard_failures.join(" | "), t0);
          if (!validation.passed) {
            repairRounds = 1; // hard-coded cap: latency
            t0 = Date.now();
            const repaired = await generate({ ...promptBase, prior_failures: validation.hard_failures });
            mark("repair", `${repaired.segments.length} segments`, t0);
            const second = check(repaired);
            mark("validate", second.passed ? "passed after repair" : second.hard_failures.join(" | "), t0);
            validation = second;
            attempt = repaired;
          }
          if (validation.passed) candidate = attempt;
        }
      } catch (err) {
        notices.push(err instanceof KbLlmUnavailableError ? "LLM unavailable — extractive answer returned." : `Tutor LLM error (${(err as Error).message.slice(0, 80)}) — extractive answer returned.`);
      }
    }

    if (declinedByModel) {
      outcome = "declined_no_evidence";
      message = "The retrieved passages don't answer this question, so I won't guess. The closest passages are listed below.";
    } else if (candidate) {
      outcome = "answered";
      answer = reorderCitations(candidate, ordered);
    } else {
      outcome = "extractive_fallback";
      const ex = extractiveAnswer(ordered);
      validation = check(ex);
      if (!validation.passed || ex.segments.length === 0) {
        outcome = "declined_no_evidence";
        answer = null;
        message = "I couldn't build a checked answer from the retrieved passages. The closest passages are listed below.";
      } else {
        answer = ex;
        if (repairRounds > 0) notices.push("Citation check failed after one repair round — extractive answer returned.");
      }
    }
  }

  // Challenge mode: one follow-up question from the (reviewed) bank, chosen by code.
  if (answer && outcome === "answered" && mode === "challenge" && primary) {
    try {
      const [q] = await callTool(ctx, "qbank.get_questions", { subtopic_ids: [primary], count: 1, exclude_seen: true, student_id: opts.studentId, reviewed_only: true });
      if (q) answer = { ...answer, follow_up: q.stem, follow_up_question_id: q.question_id };
    } catch { /* optional */ }
  }

  // ── RECORD ──────────────────────────────────────────────────
  const latencyMs = Date.now() - started;
  let sessionId = opts.sessionId;
  if (sessionId) {
    const [s] = await db.select().from(tutorSessions).where(and(eq(tutorSessions.id, sessionId), eq(tutorSessions.studentId, opts.studentId)));
    if (!s) sessionId = undefined;
  }
  if (!sessionId) {
    const [s] = await db.insert(tutorSessions).values({ studentId: opts.studentId }).returning({ id: tutorSessions.id });
    sessionId = s.id;
  }
  const nearest = retrieval?.nearest ?? [];
  if (deps.record === false) {
    return {
      turn_id: "not-recorded", session_id: "not-recorded", asked_at: simNow.toISOString(), question, outcome,
      mode: kbDown ? null : mode, retrieval_mode: retrieval?.retrieval_mode ?? null, subtopic_ids: subtopicIds,
      chunks: ordered, answer, message, nearest: outcome === "answered" || outcome === "extractive_fallback" ? [] : nearest,
      validation, repair_rounds: repairRounds, notices, latency_ms: Date.now() - started,
    };
  }
  const [turn] = await db.insert(tutorTurns).values({
    sessionId, studentId: opts.studentId, askedAt: simNow, question, subtopicIds, mode: kbDown ? null : mode,
    retrievalMode: retrieval?.retrieval_mode ?? null, retrievedChunkIds: retrieved.map((c) => c.chunk_id),
    answer: answer ?? { segments: [], message, nearest_chunk_ids: nearest.map((c) => c.chunk_id) },
    validationReport: validation, repairRounds, outcome,
    contextAssessmentId: opts.contextAssessmentId ?? null, contextQuestionId: opts.contextQuestionId ?? null,
    trace: { steps: trace, notices }, latencyMs,
  }).returning({ id: tutorTurns.id });

  return {
    turn_id: turn.id, session_id: sessionId, asked_at: simNow.toISOString(), question, outcome,
    mode: kbDown ? null : mode, retrieval_mode: retrieval?.retrieval_mode ?? null, subtopic_ids: subtopicIds,
    chunks: ordered, answer, message, nearest: outcome === "answered" || outcome === "extractive_fallback" ? [] : nearest,
    validation, repair_rounds: repairRounds, notices, latency_ms: latencyMs,
  };
}
