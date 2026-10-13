import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { learningActivities, learningGoals, students, studyPlans } from "../../src/db/schema.js";
import { advanceSimClock, getSimNow, markMissedActivities } from "../../src/agent/simClock.js";

let studentId: string;
let planId: string;

beforeAll(async () => {
  const [student] = await db
    .insert(students)
    .values({ name: "Clock Test Student", email: `clock-test-${Date.now()}@bloom.test`, simNow: new Date("2026-11-01T08:00:00Z") })
    .returning({ id: students.id });
  studentId = student.id;

  const [goal] = await db
    .insert(learningGoals)
    .values({ studentId, subjectId: "dsa", title: "Clock test goal", deadline: "2026-12-01", blueprint: { arr_traversal: 1 }, targetMastery: { arr_traversal: 0.75 } })
    .returning({ id: learningGoals.id });

  const [plan] = await db.insert(studyPlans).values({ studentId, goalId: goal.id, currentVersion: 1 }).returning({ id: studyPlans.id });
  planId = plan.id;
});

afterAll(async () => {
  await db.delete(learningActivities).where(eq(learningActivities.studentId, studentId));
  await db.delete(studyPlans).where(eq(studyPlans.studentId, studentId));
  await db.delete(learningGoals).where(eq(learningGoals.studentId, studentId));
  await db.delete(students).where(eq(students.id, studentId));
});

async function seedActivity(overrides: Partial<typeof learningActivities.$inferInsert> = {}) {
  const [row] = await db
    .insert(learningActivities)
    .values({
      planId,
      planVersion: 1,
      studentId,
      subtopicId: "arr_traversal",
      action: "LEARN",
      scheduledStart: new Date("2026-11-01T09:00:00Z"),
      scheduledEnd: new Date("2026-11-01T09:45:00Z"),
      durationMin: 45,
      status: "planned",
      ...overrides,
    })
    .returning();
  return row;
}

describe("getSimNow / advanceSimClock", () => {
  it("reads back the seeded sim_now", async () => {
    expect((await getSimNow(studentId)).toISOString()).toBe("2026-11-01T08:00:00.000Z");
  });

  it("advances sim_now by the given number of hours and persists it", async () => {
    const result = await advanceSimClock(studentId, 24);
    expect(result.hours).toBe(24);
    expect(result.to.getTime() - result.from.getTime()).toBe(24 * 3_600_000);
    expect((await getSimNow(studentId)).toISOString()).toBe(result.to.toISOString());
  });
});

describe("markMissedActivities", () => {
  it("marks exactly the overdue planned activities as missed, in the current plan version", async () => {
    const overdue = await seedActivity({ scheduledStart: new Date("2026-11-02T09:00:00Z"), scheduledEnd: new Date("2026-11-02T09:45:00Z") });
    const future = await seedActivity({ scheduledStart: new Date("2026-11-05T09:00:00Z"), scheduledEnd: new Date("2026-11-05T09:45:00Z") });

    const now = new Date("2026-11-03T00:00:00Z");
    const missed = await markMissedActivities(studentId, now);

    expect(missed.map((m) => m.id)).toEqual([overdue.id]);
    const [overdueRow] = await db.select().from(learningActivities).where(eq(learningActivities.id, overdue.id));
    expect(overdueRow.status).toBe("missed");
    expect(overdueRow.missedAt?.toISOString()).toBe(now.toISOString());

    const [futureRow] = await db.select().from(learningActivities).where(eq(learningActivities.id, future.id));
    expect(futureRow.status).toBe("planned");
  });

  it("is idempotent — running it again affects zero rows", async () => {
    const now = new Date("2026-11-03T00:00:00Z");
    const missed = await markMissedActivities(studentId, now);
    expect(missed).toHaveLength(0);
  });

  it("never touches activities from a superseded plan version", async () => {
    await db.update(studyPlans).set({ currentVersion: 2 }).where(eq(studyPlans.id, planId));
    const oldVersionActivity = await seedActivity({ planVersion: 1, scheduledStart: new Date("2026-11-02T09:00:00Z"), scheduledEnd: new Date("2026-11-02T09:45:00Z") });

    const missed = await markMissedActivities(studentId, new Date("2026-11-04T00:00:00Z"));
    expect(missed.map((m) => m.id)).not.toContain(oldVersionActivity.id);

    const [row] = await db.select().from(learningActivities).where(eq(learningActivities.id, oldVersionActivity.id));
    expect(row.status).toBe("planned");
  });
});
