/**
 * Availability and deadline changes (bloom-phase8-brief §A2). Both are
 * effective-dated inserts, never in-place updates — that's what lets
 * observe.ts (AVAILABILITY_CHANGED) and orchestrator.tick() (deadlineMoved,
 * see its comment) detect the change on the very next tick without any
 * extra bookkeeping table.
 */

import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { learningGoals, studentConstraints, students } from "../db/schema.js";
import { getSimNow } from "../agent/simClock.js";
import { asyncRoute, badRequest, notFound, ok, parseBody } from "../lib/http.js";

export const constraintsRouter = Router();

const availabilitySchema = z.object({
  weekly_availability: z.record(z.string(), z.array(z.object({ start: z.string(), end: z.string() }))),
  max_daily_study_min: z.number().int().min(15).max(24 * 60),
  min_session_min: z.number().int().min(5).optional(),
  max_session_min: z.number().int().min(5).optional(),
  blackout_dates: z.array(z.string()).optional(),
  preferred_formats: z.array(z.string()).optional(),
});

constraintsRouter.post("/students/:id/availability", asyncRoute(async (req, res) => {
  const body = parseBody(availabilitySchema, req.body);
  const [prior] = await db.select().from(studentConstraints).where(eq(studentConstraints.studentId, req.params.id)).orderBy(desc(studentConstraints.effectiveFrom)).limit(1);
  const now = await getSimNow(req.params.id);
  const [row] = await db.insert(studentConstraints).values({
    studentId: req.params.id,
    weeklyAvailability: body.weekly_availability,
    maxDailyStudyMin: body.max_daily_study_min,
    minSessionMin: body.min_session_min ?? prior?.minSessionMin ?? 15,
    maxSessionMin: body.max_session_min ?? prior?.maxSessionMin ?? Math.min(90, body.max_daily_study_min),
    blackoutDates: body.blackout_dates ?? prior?.blackoutDates ?? [],
    preferredFormats: body.preferred_formats ?? prior?.preferredFormats ?? [],
    effectiveFrom: now,
  }).returning();
  ok(res, { constraints_id: row.id, effective_from: row.effectiveFrom.toISOString() }, 201);
}));

const deadlineSchema = z.object({ deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "deadline must be YYYY-MM-DD") });

constraintsRouter.post("/students/:id/deadline", asyncRoute(async (req, res) => {
  const body = parseBody(deadlineSchema, req.body);
  const [student] = await db.select().from(students).where(eq(students.id, req.params.id));
  if (!student) throw notFound(`Student ${req.params.id} not found`);
  const [goal] = await db.select().from(learningGoals).where(and(eq(learningGoals.studentId, req.params.id), eq(learningGoals.status, "active"))).orderBy(desc(learningGoals.createdAt)).limit(1);
  if (!goal) throw notFound("No active learning goal for this student.");

  const days = (new Date(`${body.deadline}T23:59:59Z`).getTime() - student.simNow.getTime()) / 86_400_000;
  if (days < 1 || days > 60) throw badRequest(`New deadline must be 1–60 days out (got ${days.toFixed(1)}).`, "deadline", "GOAL_DEADLINE_TOO_FAR");

  const [newGoal] = await db.transaction(async (tx) => {
    await tx.update(learningGoals).set({ status: "abandoned" }).where(eq(learningGoals.id, goal.id));
    return tx.insert(learningGoals).values({
      studentId: goal.studentId, subjectId: goal.subjectId, title: goal.title, deadline: body.deadline,
      blueprint: goal.blueprint, targetMastery: goal.targetMastery, mustHaveSubtopics: goal.mustHaveSubtopics, status: "active",
    }).returning();
  });

  ok(res, { goal_id: newGoal.id, deadline: newGoal.deadline, previous_goal_id: goal.id }, 201);
}));
