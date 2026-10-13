/**
 * Assessment routes (bloom-phase8-brief §A2). GET strips correct_index
 * server-side — never trust the frontend not to render it, per the brief's
 * own warning.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { assessments } from "../db/schema.js";
import { composeAssessment, submitAnswers } from "../tools/qbank.js";
import { asyncRoute, badRequest, notFound, ok, parseBody } from "../lib/http.js";

export const assessmentsRouter = Router();

// Not in the original route list — the Demo Panel's "Take assessment" action and the
// Assessment screen both need a way to start one on demand, and the only existing path
// to qbank.compose_assessment was internal to the planner's ACT phase. Thin wrapper,
// same tool Phase 5 already validated.
const createSchema = z.object({
  student_id: z.string().uuid(), subtopic_id: z.string(),
  purpose: z.enum(["diagnostic", "checkpoint", "immediate", "active_recall", "retest", "final"]).default("immediate"),
  count: z.number().int().min(1).max(50).default(10),
});

assessmentsRouter.post("/students/:id/assessments", asyncRoute(async (req, res) => {
  const body = parseBody(createSchema, req.body);
  if (body.student_id !== req.params.id) throw badRequest("student_id must match the URL.", "student_id");
  const result = await composeAssessment({ student_id: body.student_id, subtopic_id: body.subtopic_id, purpose: body.purpose, count: body.count });
  ok(res, result, 201);
}));

assessmentsRouter.get("/assessments/:id", asyncRoute(async (req, res) => {
  const [assessment] = await db.select().from(assessments).where(eq(assessments.id, req.params.id));
  if (!assessment) throw notFound(`Assessment ${req.params.id} not found`);

  // Preserve question order as composed, not DB return order — fetched by the full id set below.
  const all = assessment.questionIds.length > 0
    ? await db.query.questions.findMany({ where: (q, { inArray }) => inArray(q.id, assessment.questionIds) })
    : [];
  const allById = new Map(all.map((q) => [q.id, q]));

  ok(res, {
    assessment_id: assessment.id,
    purpose: assessment.purpose,
    subtopic_ids: assessment.subtopicIds,
    predicted_score: Number(assessment.predictedScore),
    submitted: assessment.submittedAt !== null,
    questions: assessment.questionIds.map((id) => {
      const q = allById.get(id);
      if (!q) return null;
      // Deliberately no correct_index, no explanation — those are answer keys.
      return { question_id: q.id, subtopic_id: q.subtopicId, concept_id: q.conceptId, difficulty: q.difficulty, stem: q.stem, options: q.options };
    }).filter((q): q is NonNullable<typeof q> => q !== null),
  });
}));

const submitSchema = z.object({
  answers: z.array(z.object({ question_id: z.string(), chosen_index: z.number().int().min(0), time_sec: z.number().int().positive().optional() })),
  idempotency_key: z.string().optional(),
});

assessmentsRouter.post("/assessments/:id/submit", asyncRoute(async (req, res) => {
  const body = parseBody(submitSchema, req.body);
  const [assessment] = await db.select().from(assessments).where(eq(assessments.id, req.params.id));
  if (!assessment) throw notFound(`Assessment ${req.params.id} not found`);
  const result = await submitAnswers({ assessment_id: req.params.id, answers: body.answers, idempotency_key: body.idempotency_key });
  ok(res, {
    score: result.score, per_topic: result.per_subtopic, per_concept: result.per_concept,
    predicted_score: Number(assessment.predictedScore), prediction_error: result.prediction_error,
    newly_weak_questions: result.revision_pool_additions, cleared_questions: result.cleared_questions,
    submitted_at: result.submitted_at,
    review_sources: result.review_sources, review_sources_note: result.review_sources_note,
  });
}));
