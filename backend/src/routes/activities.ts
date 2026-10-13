/**
 * Activity lifecycle (bloom-phase8-brief §A2). These routes only flip status
 * and timestamps — the orchestrator's OBSERVE phase (agent/observe.ts) is
 * what turns a completed row into an ACTIVITY_COMPLETED observation and,
 * from there, a belief update. Nothing here writes to subtopic_mastery.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { learningActivities, resourceFeedback } from "../db/schema.js";
import { getSimNow } from "../agent/simClock.js";
import { asyncRoute, notFound, ok, parseBody, withIdempotency } from "../lib/http.js";

export const activitiesRouter = Router();

async function loadActivity(id: string) {
  const [row] = await db.select().from(learningActivities).where(eq(learningActivities.id, id));
  if (!row) throw notFound(`Activity ${id} not found`);
  return row;
}

const completeSchema = z.object({
  actual_duration_min: z.number().int().positive(),
  self_rated_difficulty: z.number().int().min(1).max(5).optional(),
  resource_feedback: z.enum(["helpful", "unhelpful", "dead_link"]).optional(),
  idempotency_key: z.string().optional(),
});

activitiesRouter.post("/activities/:id/complete", asyncRoute(async (req, res) => {
  const body = parseBody(completeSchema, req.body);
  const activity = await loadActivity(req.params.id);
  const result = await withIdempotency({
    endpoint: "activities.complete", key: body.idempotency_key,
    run: async () => {
      const now = await getSimNow(activity.studentId);
      const [updated] = await db.update(learningActivities)
        .set({ status: "completed", completedAt: now, actualDurationMin: body.actual_duration_min, selfRatedDifficulty: body.self_rated_difficulty ?? null })
        .where(eq(learningActivities.id, activity.id)).returning();
      if (body.resource_feedback && activity.resourceId) {
        await db.insert(resourceFeedback).values({ studentId: activity.studentId, resourceId: activity.resourceId, rating: body.resource_feedback });
      }
      return { activity_id: updated.id, status: updated.status, completed_at: updated.completedAt?.toISOString() ?? null };
    },
  });
  ok(res, result);
}));

const missedSchema = z.object({ idempotency_key: z.string().optional() });

activitiesRouter.post("/activities/:id/missed", asyncRoute(async (req, res) => {
  const body = parseBody(missedSchema, req.body);
  const activity = await loadActivity(req.params.id);
  const result = await withIdempotency({
    endpoint: "activities.missed", key: body.idempotency_key,
    run: async () => {
      const now = await getSimNow(activity.studentId);
      const [updated] = await db.update(learningActivities).set({ status: "missed", missedAt: now }).where(eq(learningActivities.id, activity.id)).returning();
      return { activity_id: updated.id, status: updated.status, missed_at: updated.missedAt?.toISOString() ?? null };
    },
  });
  ok(res, result);
}));

activitiesRouter.post("/activities/:id/start", asyncRoute(async (req, res) => {
  const activity = await loadActivity(req.params.id);
  const [updated] = await db.update(learningActivities).set({ status: "in_progress" }).where(eq(learningActivities.id, activity.id)).returning();
  ok(res, { activity_id: updated.id, status: updated.status });
}));
