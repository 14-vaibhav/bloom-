import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { students, studentConstraints, calendarEvents } from "../schema.js";

const DATA_DIR = path.resolve(import.meta.dirname, "data");

type StudentJson = {
  student: { name: string; email: string; simNow: string };
  constraints: {
    weeklyAvailability: Record<string, Array<{ start: string; end: string }>>;
    maxDailyStudyMin: number; minSessionMin: number; maxSessionMin: number;
    blackoutDates: string[]; preferredFormats: string[]; effectiveFrom: string;
  };
  calendarEvents: Array<{ title: string; startsAt: string; endsAt: string }>;
};

export async function seedStudent() {
  const data: StudentJson = JSON.parse(await readFile(path.join(DATA_DIR, "student.json"), "utf-8"));

  const existing = await db.select().from(students).where(eq(students.email, data.student.email));
  let studentId: string;

  if (existing.length > 0) {
    studentId = existing[0].id;
    await db.update(students).set({ simNow: new Date(data.student.simNow) }).where(eq(students.id, studentId));
  } else {
    const [inserted] = await db
      .insert(students)
      .values({ name: data.student.name, email: data.student.email, simNow: new Date(data.student.simNow) })
      .returning({ id: students.id });
    studentId = inserted.id;
  }
  console.log(`  student: ${data.student.email} (${studentId})`);

  const existingConstraints = await db
    .select()
    .from(studentConstraints)
    .where(eq(studentConstraints.studentId, studentId));
  if (existingConstraints.length === 0) {
    await db.insert(studentConstraints).values({
      studentId,
      weeklyAvailability: data.constraints.weeklyAvailability,
      maxDailyStudyMin: data.constraints.maxDailyStudyMin,
      minSessionMin: data.constraints.minSessionMin,
      maxSessionMin: data.constraints.maxSessionMin,
      blackoutDates: data.constraints.blackoutDates,
      preferredFormats: data.constraints.preferredFormats,
      effectiveFrom: new Date(data.constraints.effectiveFrom),
    });
    console.log("  constraints: seeded");
  } else {
    console.log("  constraints: already present, left as-is (effective-dated, never updated in place)");
  }

  const existingEvents = await db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.studentId, studentId));
  if (existingEvents.length === 0) {
    await db.insert(calendarEvents).values(
      data.calendarEvents.map((e) => ({
        studentId,
        title: e.title,
        startsAt: new Date(e.startsAt),
        endsAt: new Date(e.endsAt),
        source: "external" as const,
        busy: true,
      })),
    );
    console.log(`  calendar events: ${data.calendarEvents.length}`);
  } else {
    console.log(`  calendar events: ${existingEvents.length} already present`);
  }

  return { studentId };
}
