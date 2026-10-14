/**
 * Catalog & onboarding routes (bloom-phase8-brief §A2). Subject browsing,
 * blueprint confirmation, and the 15-question diagnostic that seeds the
 * first belief observations before the agent ever runs.
 */

import { Router } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  assessments, learningGoals, questions, studentConstraints, students,
  sources, subjects, subtopicPrerequisites, subtopics, topicPrerequisites, topics,
} from "../db/schema.js";
import { buildDefaultBlueprint } from "../agent/assemble.js";
import { asyncRoute, badRequest, notFound, ok, parseBody } from "../lib/http.js";
import { assertOwns } from "../lib/auth.js";

export const catalogRouter = Router();

// Purely cosmetic catalog chrome — the subjects table itself carries no editorial
// copy, and these four subjects are the fixed Phase 1 seed set.
const SUBJECT_META: Record<string, { description: string; icon: string }> = {
  dsa: { description: "Data structures and algorithms — arrays through dynamic programming.", icon: "binary-tree" },
  cn: { description: "Computer networks — OSI layers through congestion control.", icon: "network" },
  rdbms: { description: "Relational databases — modeling through transactions.", icon: "database" },
  oop: { description: "Object-oriented design — encapsulation through design patterns.", icon: "shapes" },
};

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

catalogRouter.get("/subjects", asyncRoute(async (_req, res) => {
  const rows = await db.select().from(subjects);
  const counts = await db.select({ subjectId: topics.subjectId, count: sql<number>`count(*)`.mapWith(Number) })
    .from(subtopics).innerJoin(topics, eq(subtopics.topicId, topics.id)).groupBy(topics.subjectId);
  const countBySubject = new Map(counts.map((c) => [c.subjectId, c.count]));
  const withMaterial = new Set((await db.selectDistinct({ subjectId: sources.subjectId }).from(sources)).map((r) => r.subjectId));
  ok(res, rows.map((s) => ({
    has_course_material: withMaterial.has(s.id),
    id: s.id, name: s.name,
    description: SUBJECT_META[s.id]?.description ?? "", icon: SUBJECT_META[s.id]?.icon ?? "book",
    topic_count: countBySubject.get(s.id) ?? 0,
  })));
}));

catalogRouter.get("/subjects/:id/tree", asyncRoute(async (req, res) => {
  const [subject] = await db.select().from(subjects).where(eq(subjects.id, req.params.id));
  if (!subject) throw notFound(`Subject ${req.params.id} not found`);

  const [topicRows, subtopicRows, topicPrereqs, subtopicPrereqs] = await Promise.all([
    db.select().from(topics).where(eq(topics.subjectId, subject.id)),
    db.select().from(subtopics).innerJoin(topics, eq(subtopics.topicId, topics.id)).where(eq(topics.subjectId, subject.id)),
    db.select().from(topicPrerequisites).innerJoin(topics, eq(topicPrerequisites.topicId, topics.id)).where(eq(topics.subjectId, subject.id)),
    db.select({ subtopicId: subtopicPrerequisites.subtopicId, prereqId: subtopicPrerequisites.prereqId, strength: subtopicPrerequisites.strength })
      .from(subtopicPrerequisites)
      .innerJoin(subtopics, eq(subtopicPrerequisites.subtopicId, subtopics.id))
      .innerJoin(topics, eq(subtopics.topicId, topics.id))
      .where(eq(topics.subjectId, subject.id)),
  ]);

  const subtopicsByTopic = new Map<string, typeof subtopicRows>();
  for (const row of subtopicRows) {
    const list = subtopicsByTopic.get(row.subtopics.topicId) ?? [];
    list.push(row);
    subtopicsByTopic.set(row.subtopics.topicId, list);
  }

  ok(res, {
    id: subject.id,
    name: subject.name,
    topics: topicRows.map((t) => ({
      id: t.id, name: t.name, weight: num(t.weight), base_hours: num(t.baseHours), difficulty: t.difficulty,
      subtopics: (subtopicsByTopic.get(t.id) ?? []).map((row) => ({
        id: row.subtopics.id, name: row.subtopics.name, weight: num(row.subtopics.weight),
        base_hours: num(row.subtopics.baseHours), difficulty: row.subtopics.difficulty, description: row.subtopics.description,
      })),
    })),
    topic_prerequisites: topicPrereqs.map((r) => ({ topic_id: r.topic_prerequisites.topicId, prereq_id: r.topic_prerequisites.prereqId, strength: num(r.topic_prerequisites.strength) })),
    subtopic_prerequisites: subtopicPrereqs.map((r) => ({ subtopic_id: r.subtopicId, prereq_id: r.prereqId, strength: num(r.strength) })),
  });
}));

const createGoalSchema = z.object({
  student_id: z.string().uuid(),
  subject_id: z.string(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "deadline must be YYYY-MM-DD"),
  availability: z.record(z.string(), z.array(z.object({ start: z.string(), end: z.string() }))),
  max_daily_min: z.number().int().min(15).max(24 * 60),
});

catalogRouter.post("/goals", asyncRoute(async (req, res) => {
  const body = parseBody(createGoalSchema, req.body);
  assertOwns(req, body.student_id);
  const [subject] = await db.select().from(subjects).where(eq(subjects.id, body.subject_id));
  if (!subject) throw notFound(`Subject ${body.subject_id} not found`);

  const [student] = await db.select({ simNow: students.simNow }).from(students).where(eq(students.id, body.student_id));
  if (!student) throw notFound(`Student ${body.student_id} not found`);

  const days = (new Date(`${body.deadline}T23:59:59Z`).getTime() - student.simNow.getTime()) / 86_400_000;
  if (days < 7 || days > 60) throw badRequest(`Deadline must be 7–60 days out (got ${days.toFixed(1)}).`, "deadline", "GOAL_DEADLINE_TOO_FAR");

  const { blueprint, targetMastery } = await buildDefaultBlueprint(subject.id);
  if (Object.keys(blueprint).length === 0) throw badRequest(`Subject ${subject.id} has no subtopics.`, "subject_id");

  const [goal] = await db.insert(learningGoals).values({
    studentId: body.student_id, subjectId: subject.id, title: `${subject.name} mastery`,
    deadline: body.deadline, blueprint, targetMastery, mustHaveSubtopics: [],
  }).returning();

  await db.insert(studentConstraints).values({
    studentId: body.student_id, weeklyAvailability: body.availability, maxDailyStudyMin: body.max_daily_min,
    minSessionMin: 15, maxSessionMin: Math.min(90, body.max_daily_min), blackoutDates: [], preferredFormats: [],
    effectiveFrom: student.simNow,
  });

  ok(res, { goal_id: goal.id, subject_id: goal.subjectId, deadline: goal.deadline, blueprint, target_mastery: targetMastery }, 201);
}));

const blueprintSchema = z.object({
  weights: z.record(z.string(), z.number().min(0)),
  dropped: z.array(z.string()).default([]),
});

catalogRouter.post("/goals/:id/blueprint", asyncRoute(async (req, res) => {
  const body = parseBody(blueprintSchema, req.body);
  const [goal] = await db.select().from(learningGoals).where(eq(learningGoals.id, req.params.id));
  if (!goal) throw notFound(`Goal ${req.params.id} not found`);
  assertOwns(req, goal.studentId);

  const dropped = body.dropped;
  const mustHave = new Set(goal.mustHaveSubtopics);
  const badDrop = dropped.find((id) => mustHave.has(id));
  if (badDrop) throw badRequest(`${badDrop} is a must-have subtopic and cannot be dropped.`, "dropped", "MUST_HAVE_SUBTOPIC");

  const kept = Object.entries(body.weights).filter(([id]) => !dropped.includes(id));
  const total = kept.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) throw badRequest("At least one subtopic must keep a positive weight.", "weights");
  const normalised = Object.fromEntries(kept.map(([id, w]) => [id, w / total]));

  const targetMastery = { ...(goal.targetMastery as Record<string, number>) };
  for (const id of dropped) delete targetMastery[id];

  const [updated] = await db.update(learningGoals)
    .set({ blueprint: normalised, targetMastery })
    .where(eq(learningGoals.id, req.params.id))
    .returning();

  ok(res, { goal_id: updated.id, blueprint: normalised, dropped });
}));

catalogRouter.get("/goals/:id/diagnostic", asyncRoute(async (req, res) => {
  const [goal] = await db.select().from(learningGoals).where(eq(learningGoals.id, req.params.id));
  if (!goal) throw notFound(`Goal ${req.params.id} not found`);
  assertOwns(req, goal.studentId);
  const subtopicIds = Object.keys(goal.blueprint as Record<string, number>);

  // A diagnostic that already exists for this goal is returned as-is — creating a second
  // one on every onboarding re-render would silently burn the question pool.
  const [existing] = await db.select().from(assessments)
    .where(and(eq(assessments.studentId, goal.studentId), eq(assessments.purpose, "diagnostic")))
    .orderBy(sql`${assessments.createdAt} desc`).limit(1);
  if (existing && existing.subtopicIds.every((id) => subtopicIds.includes(id))) {
    ok(res, { assessment_id: existing.id, question_ids: existing.questionIds, subtopic_ids: existing.subtopicIds });
    return;
  }

  // Try human-reviewed questions first; fallback to unreviewed questions for the subtopics if needed
  let pool = await db.select().from(questions).where(and(inArray(questions.subtopicId, subtopicIds), eq(questions.reviewed, true)));
  if (pool.length === 0) {
    pool = await db.select().from(questions).where(inArray(questions.subtopicId, subtopicIds));
  }
  if (pool.length === 0) {
    pool = await db.select().from(questions).limit(15);
  }
  if (pool.length === 0) throw badRequest(`No diagnostic questions available.`, "subject_id");

  // Spread evenly across subtopics (one each until 15 are filled), reviewed questions first.
  const bySubtopic = new Map<string, typeof pool>();
  for (const q of pool) bySubtopic.set(q.subtopicId, [...(bySubtopic.get(q.subtopicId) ?? []), q]);
  for (const list of bySubtopic.values()) list.sort((a, b) => Number(b.reviewed) - Number(a.reviewed));

  const selected: string[] = [];
  const ids = [...bySubtopic.keys()];
  let round = 0;
  while (selected.length < 15 && ids.some((id) => (bySubtopic.get(id) ?? []).length > round)) {
    for (const id of ids) {
      if (selected.length >= 15) break;
      const q = (bySubtopic.get(id) ?? [])[round];
      if (q) selected.push(q.id);
    }
    round += 1;
  }

  const [row] = await db.insert(assessments).values({
    studentId: goal.studentId, purpose: "diagnostic", subtopicIds,
    questionIds: selected, composition: { subtopic_count: subtopicIds.length, question_count: selected.length },
    predictedScore: "0.5",
  }).returning();

  ok(res, { assessment_id: row.id, question_ids: row.questionIds, subtopic_ids: row.subtopicIds }, 201);
}));
