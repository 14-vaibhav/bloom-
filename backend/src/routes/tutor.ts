/** Tutor and knowledge-base routes (v4 §N4, §N8). */
import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { sourceChunks, sources, tutorTurns } from "../db/schema.js";
import { buildReport } from "../kb/report.js";
import { getChunk } from "../kb/retrieval.js";
import { askTutor } from "../tutor/tutor.js";
import { armBreakCitation, breakCitationArmed, disarmBreakCitation } from "../tutor/breakCitation.js";
import { callTool } from "../tools/dispatcher.js";
import { createUntrackedContext } from "../tools/context.js";
import { asyncRoute, notFound, ok, parseBody, parseQuery } from "../lib/http.js";

export const tutorRouter = Router();

tutorRouter.post("/students/:id/tutor/ask", asyncRoute(async (req, res) => {
  const body = parseBody(z.object({
    question: z.string().min(3).max(1000),
    session_id: z.string().uuid().optional(),
    context_question_id: z.string().optional(),
    context_assessment_id: z.string().uuid().optional(),
  }), req.body);
  ok(res, await askTutor({
    studentId: req.params.id, question: body.question, sessionId: body.session_id,
    contextQuestionId: body.context_question_id, contextAssessmentId: body.context_assessment_id,
  }));
}));

tutorRouter.get("/students/:id/tutor/turns", asyncRoute(async (req, res) => {
  const q = parseQuery(z.object({ session_id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  const where = q.session_id ? and(eq(tutorTurns.studentId, req.params.id), eq(tutorTurns.sessionId, q.session_id)) : eq(tutorTurns.studentId, req.params.id);
  const rows = await db.select().from(tutorTurns).where(where).orderBy(q.session_id ? asc(tutorTurns.askedAt) : desc(tutorTurns.askedAt)).limit(q.limit);
  ok(res, rows.map((r) => ({
    turn_id: r.id, session_id: r.sessionId, asked_at: r.askedAt.toISOString(), question: r.question, subtopic_ids: r.subtopicIds,
    mode: r.mode, retrieval_mode: r.retrievalMode, retrieved_chunk_ids: r.retrievedChunkIds, answer: r.answer,
    validation_report: r.validationReport, repair_rounds: r.repairRounds, outcome: r.outcome, latency_ms: r.latencyMs,
  })));
}));

// Chunks backing the citation chips of a stored turn (so a refresh can re-render them).
tutorRouter.post("/kb/chunks", asyncRoute(async (req, res) => {
  const body = parseBody(z.object({ chunk_ids: z.array(z.string()).max(50) }), req.body);
  const chunks = [];
  for (const id of body.chunk_ids) {
    const c = await getChunk(id);
    if (c) chunks.push(c);
  }
  ok(res, chunks);
}));

tutorRouter.get("/kb/chunks/:id", asyncRoute(async (req, res) => {
  const chunk = await getChunk(req.params.id);
  if (!chunk) throw notFound(`Chunk ${req.params.id} not found`);
  ok(res, chunk);
}));

tutorRouter.get("/kb/report", asyncRoute(async (req, res) => {
  const q = parseQuery(z.object({ subject_id: z.string().optional() }), req.query);
  ok(res, await buildReport(q.subject_id));
}));

tutorRouter.get("/kb/sources", asyncRoute(async (_req, res) => {
  const rows = await db.select().from(sources).orderBy(asc(sources.id));
  ok(res, rows.map((s) => ({ id: s.id, subject_id: s.subjectId, kind: s.kind, title: s.title, provider: s.provider, url: s.url, license: s.license, duration_sec: s.durationSec, unit_count: s.unitCount, ingested_at: s.ingestedAt?.toISOString() ?? null })));
}));

tutorRouter.get("/kb/sources/:id/outline", asyncRoute(async (req, res) => {
  const [src] = await db.select({ id: sources.id }).from(sources).where(eq(sources.id, req.params.id));
  if (!src) throw notFound(`Source ${req.params.id} not found`);
  const ctx = createUntrackedContext({ studentId: "00000000-0000-0000-0000-000000000000" });
  ok(res, await callTool(ctx, "kb.get_source_outline", { source_id: req.params.id }));
}));

// full text of a chunk's source page/slide neighbourhood for the Source Viewer
tutorRouter.get("/kb/sources/:id/units/:seq", asyncRoute(async (req, res) => {
  const [row] = await db.select().from(sourceChunks).where(and(eq(sourceChunks.sourceId, req.params.id), eq(sourceChunks.seq, Number(req.params.seq))));
  if (!row) throw notFound("Unit not found");
  const chunk = await getChunk(row.id);
  ok(res, chunk);
}));

// Demo Panel: "Break citation" arms a one-shot corruption of the tutor's first attempt.
tutorRouter.post("/sim/break-citation", asyncRoute(async (req, res) => {
  const body = parseBody(z.object({ armed: z.boolean().default(true) }), req.body ?? {});
  if (body.armed) armBreakCitation(); else disarmBreakCitation();
  ok(res, { armed: breakCitationArmed() });
}));
tutorRouter.get("/sim/break-citation", asyncRoute(async (_req, res) => { ok(res, { armed: breakCitationArmed() }); }));
