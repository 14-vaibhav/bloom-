/**
 * Student state, performance, mastery tree, weaknesses, revision pool and
 * daily summary (bloom-phase8-brief §A2). Reads only — no route here writes
 * a mastery number or badge; those already live in core/agent and this
 * layer just serialises them.
 */

import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  concepts, dailySummaries, learningGoals, masteryObservations, questionAttempts,
  questionState, questions, students, subtopics, topics,
} from "../db/schema.js";
import { getAllBeliefs } from "../agent/beliefs.js";
import { computeMasteryBadge } from "../core/badge.js";
import { getWeaknessScore } from "../core/weakness.js";
import { getStudentPerformance, getSubtopicPerformance } from "../tools/performance.js";
import { getRevisionPool } from "../tools/qbank.js";
import { asyncRoute, notFound, ok, parseQuery } from "../lib/http.js";
import { authRequired } from "../lib/auth.js";

export const studentsRouter = Router();

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

async function loadActiveGoal(studentId: string) {
  const [goal] = await db.select().from(learningGoals)
    .where(and(eq(learningGoals.studentId, studentId), eq(learningGoals.status, "active")))
    .orderBy(desc(learningGoals.createdAt)).limit(1);
  return goal ?? null;
}

// Not in the original route list — the frontend has no auth and no other way to
// discover which student id to bootstrap onboarding with, short of hardcoding a
// UUID. Single-tenant by design (one seeded demo student per deployment).
studentsRouter.get("/students", asyncRoute(async (req, res) => {
  const rows = await db.select({ id: students.id, name: students.name, email: students.email }).from(students);
  // With auth enforced a caller sees only themselves — never the roster.
  ok(res, authRequired() ? rows.filter((r) => r.id === req.auth?.studentId) : rows);
}));

studentsRouter.get("/students/:id/state", asyncRoute(async (req, res) => {
  const { getStudentState } = await import("../tools/state.js");
  ok(res, await getStudentState({ student_id: req.params.id }));
}));

studentsRouter.get("/students/:id/performance", asyncRoute(async (req, res) => {
  const overall = await getStudentPerformance({ student_id: req.params.id });
  const perSubtopic = await getSubtopicPerformance({ student_id: req.params.id });
  const history = await db.select().from(masteryObservations)
    .where(eq(masteryObservations.studentId, req.params.id))
    .orderBy(masteryObservations.observedAt);
  ok(res, {
    ...overall,
    per_subtopic: perSubtopic,
    observation_history: history.map((o) => ({
      subtopic_id: o.subtopicId, observed_at: o.observedAt.toISOString(), source: o.source,
      mu_before: num(o.muBefore), mu_after: num(o.muAfter),
      confidence_before: num(o.confidenceBefore), confidence_after: num(o.confidenceAfter),
    })),
  });
}));

studentsRouter.get("/students/:id/mastery-tree", asyncRoute(async (req, res) => {
  const goal = await loadActiveGoal(req.params.id);
  if (!goal) throw notFound("No active learning goal for this student.");

  const [topicRows, subtopicRows] = await Promise.all([
    db.select().from(topics).where(eq(topics.subjectId, goal.subjectId)),
    db.select().from(subtopics).innerJoin(topics, eq(subtopics.topicId, topics.id)).where(eq(topics.subjectId, goal.subjectId)),
  ]);
  const subtopicIds = subtopicRows.map((r) => r.subtopics.id);
  const [beliefsMap, assessmentEvidence] = await Promise.all([
    getAllBeliefs(req.params.id, subtopicIds),
    db.select().from(masteryObservations).where(and(eq(masteryObservations.studentId, req.params.id), eq(masteryObservations.source, "assessment"), inArray(masteryObservations.subtopicId, subtopicIds))),
  ]);

  const evidenceBySubtopic = new Map<string, { count: number; maxDifficulty: number }>();
  for (const row of assessmentEvidence) {
    const entry = evidenceBySubtopic.get(row.subtopicId) ?? { count: 0, maxDifficulty: 0 };
    entry.count += 1;
    const difficulty = num((row.evidence as { difficulty?: number } | null)?.difficulty);
    entry.maxDifficulty = Math.max(entry.maxDifficulty, difficulty);
    evidenceBySubtopic.set(row.subtopicId, entry);
  }

  const targetMastery = goal.targetMastery as Record<string, number>;
  const subtopicsByTopic = new Map<string, typeof subtopicRows>();
  for (const row of subtopicRows) subtopicsByTopic.set(row.subtopics.topicId, [...(subtopicsByTopic.get(row.subtopics.topicId) ?? []), row]);

  const now = new Date();
  ok(res, {
    subject_id: goal.subjectId,
    topics: topicRows.map((t) => ({
      id: t.id, name: t.name,
      subtopics: (subtopicsByTopic.get(t.id) ?? []).map((row) => {
        const s = row.subtopics;
        const belief = beliefsMap.get(s.id);
        const evidence = evidenceBySubtopic.get(s.id) ?? { count: 0, maxDifficulty: 0 };
        const target = targetMastery[s.id] ?? 0.75;
        const badge = belief
          ? computeMasteryBadge(belief, target, now, { assessment_count: evidence.count, had_assessment_at_or_above_target_difficulty: evidence.maxDifficulty >= s.difficulty })
          : { level: "grey" as const, reasons: [] };
        return {
          id: s.id, name: s.name, target_mastery: target,
          mu: belief?.mu ?? 0, confidence: belief?.confidence ?? 0,
          badge: badge.level, badge_reasons: badge.reasons,
        };
      }),
    })),
  });
}));

studentsRouter.get("/students/:id/weaknesses", asyncRoute(async (req, res) => {
  const rows = await db
    .select({
      subtopicId: questions.subtopicId, conceptId: questions.conceptId, conceptName: concepts.name,
      questionId: questions.id, stem: questions.stem,
      timesAttempted: questionState.timesSeen, timesCorrect: questionState.timesCorrect,
      lastSeenAt: questionState.lastSeenAt, weaknessScore: questionState.weaknessScore, inRevisionPool: questionState.inRevisionPool,
    })
    .from(questionState)
    .innerJoin(questions, eq(questions.id, questionState.questionId))
    .leftJoin(concepts, eq(concepts.id, questions.conceptId))
    .where(and(eq(questionState.studentId, req.params.id), eq(questionState.inRevisionPool, true)));

  const bySubtopic = new Map<string, Map<string, { concept_id: string; concept_name: string; questions: unknown[] }>>();
  for (const r of rows) {
    const subtopicMap = bySubtopic.get(r.subtopicId) ?? new Map();
    const conceptKey = r.conceptId ?? "unclassified";
    const conceptEntry = subtopicMap.get(conceptKey) ?? { concept_id: conceptKey, concept_name: r.conceptName ?? "Unclassified", questions: [] };
    conceptEntry.questions.push({
      question_id: r.questionId, stem: r.stem, times_attempted: r.timesAttempted, times_correct: r.timesCorrect,
      weakness_score: num(r.weaknessScore), last_seen_at: r.lastSeenAt?.toISOString() ?? null,
    });
    subtopicMap.set(conceptKey, conceptEntry);
    bySubtopic.set(r.subtopicId, subtopicMap);
  }

  ok(res, [...bySubtopic.entries()].map(([subtopicId, conceptMap]) => ({
    subtopic_id: subtopicId,
    concepts: [...conceptMap.values()].sort((a, b) => (b.questions.length) - (a.questions.length)),
  })));
}));

studentsRouter.get("/students/:id/revision-pool", asyncRoute(async (req, res) => {
  const query = parseQuery(z.object({ subtopic_id: z.string().optional() }), req.query);
  ok(res, await getRevisionPool({ student_id: req.params.id, subtopic_id: query.subtopic_id }));
}));

studentsRouter.get("/students/:id/daily-summary", asyncRoute(async (req, res) => {
  const query = parseQuery(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
  const [row] = query.date
    ? await db.select().from(dailySummaries).where(and(eq(dailySummaries.studentId, req.params.id), eq(dailySummaries.summaryDate, query.date)))
    : await db.select().from(dailySummaries).where(eq(dailySummaries.studentId, req.params.id)).orderBy(desc(dailySummaries.summaryDate)).limit(1);
  if (!row) throw notFound("No daily summary yet for this student — the agent writes one on its first tick.");
  ok(res, { date: row.summaryDate, message: row.message, ...(row.stats as object) });
}));
