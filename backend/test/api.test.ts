import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { assessments, learningActivities, questions, students, subjects, subtopics, topics } from "../src/db/schema.js";

const app = createApp();

let studentId: string;
let subjectId: string;

beforeAll(async () => {
  const [student] = await db.insert(students).values({ name: "API Test Student", email: `api-test-${crypto.randomUUID()}@bloom.test`, simNow: new Date("2026-01-01T00:00:00Z") }).returning({ id: students.id });
  studentId = student.id;
  const [subjectRow] = await db.select().from(subjects).limit(1);
  subjectId = subjectRow.id;
});

afterAll(async () => {
  await db.delete(learningActivities).where(eq(learningActivities.studentId, studentId));
  await db.delete(assessments).where(eq(assessments.studentId, studentId));
  await db.delete(students).where(eq(students.id, studentId));
});

describe("REST API validation and envelope (bloom-phase8-brief §A2/§A6)", () => {
  it("returns { ok: true, data } for a simple GET", async () => {
    const res = await request(app).get("/api/subjects");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("rejects a malformed body with a 400 and a field-level error", async () => {
    const res = await request(app).post("/api/goals").send({ subject_id: subjectId });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBeTruthy();
  });

  it("rejects a 90-day deadline as GOAL_DEADLINE_TOO_FAR", async () => {
    const res = await request(app).post("/api/goals").send({
      student_id: studentId, subject_id: subjectId, deadline: "2026-04-15", // ~104 days out
      availability: { "1": [{ start: "18:00", end: "20:00" }] }, max_daily_min: 60,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("GOAL_DEADLINE_TOO_FAR");
    expect(res.body.error.field).toBe("deadline");
  });

  it("accepts a 45-day deadline", async () => {
    const res = await request(app).post("/api/goals").send({
      student_id: studentId, subject_id: subjectId, deadline: "2026-02-15", // 45 days out
      availability: { "1": [{ start: "18:00", end: "20:00" }] }, max_daily_min: 60,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.goal_id).toBeTruthy();
  });

  it("404s on an unknown activity id instead of 500", async () => {
    const res = await request(app).post(`/api/activities/${crypto.randomUUID()}/complete`).send({ actual_duration_min: 30 });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it("GET /assessments/:id never includes correct_index anywhere in the payload", async () => {
    const [subtopic] = await db.select({ id: subtopics.id, topicId: subtopics.topicId }).from(subtopics).innerJoin(topics, eq(subtopics.topicId, topics.id)).where(eq(topics.subjectId, subjectId)).limit(1);
    const fakeQuestions = [0, 1].map((i) => ({
      id: `api-test-q-${crypto.randomUUID()}-${i}`, subjectId, topicId: subtopic.topicId, subtopicId: subtopic.id,
      difficulty: 2 as const, stem: `Test stem ${i}`, options: ["a", "b", "c", "d"], correctIndex: 2 as const, explanation: "SECRET_ANSWER_KEY",
    }));
    await db.insert(questions).values(fakeQuestions);
    const [assessment] = await db.insert(assessments).values({
      studentId, purpose: "diagnostic", subtopicIds: [subtopic.id], questionIds: fakeQuestions.map((q) => q.id), predictedScore: "0.5",
    }).returning();

    const res = await request(app).get(`/api/assessments/${assessment.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.questions).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain("correct_index");
    expect(JSON.stringify(res.body)).not.toContain("SECRET_ANSWER_KEY");

    await db.delete(questions).where(eq(questions.id, fakeQuestions[0].id));
    await db.delete(questions).where(eq(questions.id, fakeQuestions[1].id));
  });

  it("double-submits an activity completion with the same idempotency key and gets one result back", async () => {
    const [subtopic] = await db.select({ id: subtopics.id }).from(subtopics).innerJoin(topics, eq(subtopics.topicId, topics.id)).where(eq(topics.subjectId, subjectId)).limit(1);
    const [activity] = await db.insert(learningActivities).values({
      planId: crypto.randomUUID(), planVersion: 1, studentId, subtopicId: subtopic.id,
      action: "PRACTICE", scheduledStart: new Date("2026-01-01T10:00:00Z"), scheduledEnd: new Date("2026-01-01T10:30:00Z"), durationMin: 30,
    }).returning();

    const key = crypto.randomUUID();
    const first = await request(app).post(`/api/activities/${activity.id}/complete`).send({ actual_duration_min: 25, idempotency_key: key });
    const second = await request(app).post(`/api/activities/${activity.id}/complete`).send({ actual_duration_min: 25, idempotency_key: key });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data).toEqual(second.body.data);
  });
});
