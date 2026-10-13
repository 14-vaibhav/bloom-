/**
 * Plan history and diff routes (bloom-phase8-brief §A2). The diff route
 * reuses agent/diff.ts's lineage-matched computePlanDiff so the "1 moved,
 * 21 unchanged" claim in the Plan Changes screen is the same arithmetic the
 * orchestrator itself already trusts, not a second implementation of it.
 */

import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { learningActivities, learningGoals, planVersions, resources, studyPlans } from "../db/schema.js";
import { inArray } from "drizzle-orm";
import { computePlanDiff, type DiffAfterActivity, type DiffBeforeActivity } from "../agent/diff.js";
import { getPlan } from "../tools/state.js";
import { asyncRoute, notFound, ok, parseQuery } from "../lib/http.js";

export const plansRouter = Router();

async function activePlanForStudent(studentId: string) {
  // Same rule everywhere a route needs "the" plan: resolve via the active goal, never an
  // unordered first row — see the comment on tools/state.ts's getPlan for why that matters.
  const [activeGoal] = await db
    .select({ id: learningGoals.id })
    .from(learningGoals)
    .where(and(eq(learningGoals.studentId, studentId), eq(learningGoals.status, "active")))
    .orderBy(desc(learningGoals.createdAt))
    .limit(1);
  if (!activeGoal) return null;
  const [plan] = await db.select().from(studyPlans).where(eq(studyPlans.goalId, activeGoal.id));
  return plan ?? null;
}

plansRouter.get("/students/:id/plan", asyncRoute(async (req, res) => {
  const query = parseQuery(z.object({ version: z.coerce.number().int().optional() }), req.query);
  const plan = await getPlan({ student_id: req.params.id, version: query.version });
  if (!plan) throw notFound("No plan exists yet for this student.");
  // v4 §N8.3: a LEARN/REVISION card whose resource is a knowledge-base segment reads "Lecture 5, 14:20–22:05".
  const resourceIds = [...new Set(plan.activities.map((a) => a.resource_id).filter((id): id is string => !!id))];
  const rows = resourceIds.length ? await db.select().from(resources).where(inArray(resources.id, resourceIds)) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  ok(res, {
    ...plan,
    activities: plan.activities.map((a) => {
      const r = a.resource_id ? byId.get(a.resource_id) : undefined;
      return { ...a, resource: r ? { title: r.title, url: r.url, type: r.type, source_id: r.sourceId, locator_range: r.locatorRange } : null };
    }),
  });
}));

plansRouter.get("/students/:id/plans", asyncRoute(async (req, res) => {
  const plan = await activePlanForStudent(req.params.id);
  if (!plan) throw notFound("No plan exists yet for this student.");
  const versions = await db.select().from(planVersions).where(eq(planVersions.planId, plan.id)).orderBy(planVersions.version);
  ok(res, versions.map((v) => ({
    version: v.version, parent_version: v.parentVersion, trigger: v.trigger, scope: v.scope, reason: v.reason,
    repair_rounds: v.repairRounds, created_at: v.createdAt.toISOString(),
  })));
}));

async function activitiesForVersion(planId: string, version: number): Promise<Array<typeof learningActivities.$inferSelect>> {
  return db.select().from(learningActivities).where(and(eq(learningActivities.planId, planId), eq(learningActivities.planVersion, version)));
}

function toBefore(a: typeof learningActivities.$inferSelect): DiffBeforeActivity {
  return { activity_id: a.id, subtopic_id: a.subtopicId, action: a.action, start: a.scheduledStart.toISOString(), end: a.scheduledEnd.toISOString(), resource_id: a.resourceId, duration_min: a.durationMin };
}
function toAfter(a: typeof learningActivities.$inferSelect): DiffAfterActivity {
  return { ...toBefore(a), carried_from_activity_id: a.carriedFromActivityId };
}

plansRouter.get("/students/:id/plan/diff", asyncRoute(async (req, res) => {
  const query = parseQuery(z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }), req.query);
  const plan = await activePlanForStudent(req.params.id);
  if (!plan) throw notFound("No plan exists yet for this student.");
  const [before, after] = await Promise.all([activitiesForVersion(plan.id, query.from), activitiesForVersion(plan.id, query.to)]);
  ok(res, computePlanDiff(before.map(toBefore), after.map(toAfter)));
}));

plansRouter.get("/plan-versions/:id/validation", asyncRoute(async (req, res) => {
  const [row] = await db.select().from(planVersions).where(eq(planVersions.id, req.params.id));
  if (!row) throw notFound(`Plan version ${req.params.id} not found`);
  ok(res, { version: row.version, scope: row.scope, repair_rounds: row.repairRounds, report: row.validationReport });
}));
