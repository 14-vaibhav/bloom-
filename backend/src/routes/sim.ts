/**
 * Simulation & demo-panel routes (bloom-phase8-brief §A2). break-tool /
 * restore-tool manipulate tool_health directly rather than actually failing
 * calls — the demo needs a deterministic, instant break, not a race against
 * real failures. `reset` restores just the demo student's state (goal,
 * plan, activities, beliefs, events) to the seed baseline; it never touches
 * the catalog (subjects/resources/questions), which is shared and does not
 * change per demo run.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  agentEvents, agentRuns, assessments, calendarEvents, dailySummaries, tutorSessions, tutorTurns,
  learningActivities, learningGoals, masteryObservations, questionAttempts,
  questionState, resourceFeedback, studentConstraints, students, studyPlans, subtopicMastery, toolHealth,
} from "../db/schema.js";
import { advanceSimClock } from "../agent/simClock.js";
import { seedStudent } from "../db/seed/student.js";
import { tick } from "../agent/orchestrator.js";
import { asyncRoute, badRequest, notFound, ok, parseBody } from "../lib/http.js";
import type { ToolBucket } from "../tools/errors.js";
import { assertOwns } from "../lib/auth.js";

export const simRouter = Router();

simRouter.post("/sim/advance", asyncRoute(async (req, res) => {
  const body = parseBody(z.object({ student_id: z.string().uuid(), hours: z.number().positive() }), req.body);
  assertOwns(req, body.student_id);
  ok(res, await advanceSimClock(body.student_id, body.hours));
}));

const TOOL_BUCKETS: ToolBucket[] = ["performance", "rag", "calendar", "qbank", "state", "kb", "llm"];

const breakSchema = z.object({ tool: z.enum(TOOL_BUCKETS as [ToolBucket, ...ToolBucket[]]), duration_sec: z.number().positive().optional() });
const restoreTimers = new Map<ToolBucket, NodeJS.Timeout>();

simRouter.post("/sim/break-tool", asyncRoute(async (req, res) => {
  const body = parseBody(breakSchema, req.body);
  await db.insert(toolHealth).values({ toolName: body.tool, state: "open", consecutiveFailures: 3, openedAt: new Date(), lastError: "Manually broken via demo panel." })
    .onConflictDoUpdate({ target: toolHealth.toolName, set: { state: "open", consecutiveFailures: 3, openedAt: new Date(), lastError: "Manually broken via demo panel." } });

  const existingTimer = restoreTimers.get(body.tool);
  if (existingTimer) clearTimeout(existingTimer);
  if (body.duration_sec) {
    const timer = setTimeout(() => {
      void db.update(toolHealth).set({ state: "closed", consecutiveFailures: 0, lastSuccessAt: new Date() }).where(eq(toolHealth.toolName, body.tool));
      restoreTimers.delete(body.tool);
    }, body.duration_sec * 1000);
    restoreTimers.set(body.tool, timer);
  }
  ok(res, { tool: body.tool, state: "open" });
}));

simRouter.post("/sim/restore-tool", asyncRoute(async (req, res) => {
  const body = parseBody(z.object({ tool: z.enum(TOOL_BUCKETS as [ToolBucket, ...ToolBucket[]]) }), req.body);
  const timer = restoreTimers.get(body.tool);
  if (timer) { clearTimeout(timer); restoreTimers.delete(body.tool); }
  await db.update(toolHealth).set({ state: "closed", consecutiveFailures: 0, lastSuccessAt: new Date() }).where(eq(toolHealth.toolName, body.tool));
  ok(res, { tool: body.tool, state: "closed" });
}));

/**
 * Scenarios G and H are fully specified in bloom-phase9-brief §B6 and are
 * driven for real (advance the clock, complete/miss activities, submit
 * assessments, run the tick). Scenarios A–F were defined in the Phase 6
 * brief, which is not present in this repo/session — rather than invent
 * preconditions that might contradict the original spec, unknown names run
 * a generic tick-and-advance sequence and say so in the response.
 */
simRouter.post("/sim/scenario/:name", asyncRoute(async (req, res) => {
  const body = parseBody(z.object({ student_id: z.string().uuid() }), req.body);
  assertOwns(req, body.student_id);
  const name = req.params.name.toLowerCase();
  const studentId = body.student_id;

  if (name === "g") {
    const log: unknown[] = [];
    for (let day = 0; day < 8; day++) {
      await advanceSimClock(studentId, 24);
      const [plan] = await db.select().from(studyPlans).where(eq(studyPlans.studentId, studentId));
      if (plan) {
        const now = await db.select({ simNow: students.simNow }).from(students).where(eq(students.id, studentId));
        const due = await db.query.learningActivities.findMany({
          where: (a, { and: andOp, eq: eqOp, lte }) => andOp(eqOp(a.studentId, studentId), eqOp(a.planId, plan.id), eqOp(a.planVersion, plan.currentVersion), eqOp(a.status, "planned"), lte(a.scheduledEnd, now[0].simNow)),
        });
        for (const activity of due) {
          // 60% attendance; scored activities complete at 15% below their own prediction.
          if (Math.random() < 0.6) {
            await db.update(learningActivities).set({ status: "completed", completedAt: now[0].simNow, actualDurationMin: activity.durationMin }).where(eq(learningActivities.id, activity.id));
          } else {
            await db.update(learningActivities).set({ status: "missed", missedAt: now[0].simNow }).where(eq(learningActivities.id, activity.id));
          }
        }
      }
      log.push(await tick(studentId));
    }
    ok(res, { scenario: "G", days_run: 8, log });
    return;
  }

  if (name === "h") {
    await db.insert(toolHealth).values({ toolName: "rag", state: "open", consecutiveFailures: 3, openedAt: new Date(), lastError: "Scenario H: forced break." })
      .onConflictDoUpdate({ target: toolHealth.toolName, set: { state: "open", consecutiveFailures: 3, openedAt: new Date(), lastError: "Scenario H: forced break." } });
    const brokenRun = await tick(studentId);
    await db.update(toolHealth).set({ state: "closed", consecutiveFailures: 0, lastSuccessAt: new Date() }).where(eq(toolHealth.toolName, "rag"));
    const recoveredRun = await tick(studentId);
    ok(res, { scenario: "H", broken_run: brokenRun, recovered_run: recoveredRun });
    return;
  }

  const advanced = await advanceSimClock(studentId, 24);
  const run = await tick(studentId);
  ok(res, { scenario: name.toUpperCase(), note: "Phase 6 scenario preconditions unavailable in this session; ran a generic advance+tick instead.", advanced, run });
}));

// plan_versions and assessment_results have no student_id column of their own — they
// cascade-delete from study_plans and assessments respectively (both listed below).
const STUDENT_SCOPED_TABLES = [
  tutorTurns, tutorSessions, agentEvents, agentRuns, learningActivities, studyPlans,
  assessments, questionAttempts, questionState,
  masteryObservations, subtopicMastery, resourceFeedback, dailySummaries,
  studentConstraints, learningGoals,
] as const;

simRouter.post("/sim/reset", asyncRoute(async (req, res) => {
  const body = parseBody(z.object({ student_id: z.string().uuid().optional() }), req.body);
  const [student] = body.student_id
    ? await db.select().from(students).where(eq(students.id, body.student_id))
    : await db.select().from(students).where(eq(students.email, "demo@bloom.local"));
  if (!student) throw notFound("Demo student not found — run `npm run seed` first.");
  assertOwns(req, student.id);

  for (const table of STUDENT_SCOPED_TABLES) {
    await db.delete(table).where(eq((table as typeof learningActivities).studentId, student.id));
  }
  // seedStudent() below re-inserts the full external calendar (it only seeds when none
  // exist for this student), so a clean wipe-and-reseed is simplest and exactly matches
  // student.json's baseline rather than trying to distinguish bloom vs external rows here.
  await db.delete(calendarEvents).where(eq(calendarEvents.studentId, student.id));

  const { studentId } = await seedStudent();
  ok(res, { student_id: studentId, message: "Restored to seed baseline." });
}));
