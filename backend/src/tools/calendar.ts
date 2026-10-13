/**
 * Calendar tool — reports slots and manages Bloom-created sessions. No
 * planner logic lives here: it computes free/busy and hands back candidates,
 * annotated with energy_weight so the (later) planner can prefer times the
 * student actually shows up to. All timestamps are UTC; the one wall-clock
 * conversion point is src/lib/time.ts.
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { calendarEvents, learningActivities } from "../db/schema.js";
import { eachUtcDayInRange, minutesBetween, overlaps, utcDayOfWeek, wallClockToUtc } from "../lib/time.js";
import { PermanentError } from "./errors.js";
import { resolveEffectiveConstraints } from "./shared.js";
import type { ToolInput, ToolOutput } from "./schemas.js";

type WeeklyAvailability = Record<string, Array<{ start: string; end: string }>>;

async function energyWeightByHour(studentId: string): Promise<Map<number, number>> {
  const rows = await db
    .select({ start: learningActivities.scheduledStart, status: learningActivities.status })
    .from(learningActivities)
    .where(
      and(
        eq(learningActivities.studentId, studentId),
        sql`${learningActivities.status} in ('completed','missed')`,
      ),
    );

  const byHour = new Map<number, { completed: number; total: number }>();
  for (const r of rows) {
    const hour = r.start.getUTCHours();
    const bucket = byHour.get(hour) ?? { completed: 0, total: 0 };
    bucket.total += 1;
    if (r.status === "completed") bucket.completed += 1;
    byHour.set(hour, bucket);
  }

  const weights = new Map<number, number>();
  for (const [hour, { completed, total }] of byHour) {
    weights.set(hour, total >= 5 ? completed / total : 1.0);
  }
  return weights;
}

export async function getExistingEvents(
  input: ToolInput<"calendar.get_existing_events">,
): Promise<ToolOutput<"calendar.get_existing_events">> {
  const from = new Date(input.from);
  const to = new Date(input.to);
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.studentId, input.student_id),
        gte(calendarEvents.startsAt, from),
        lte(calendarEvents.startsAt, to),
      ),
    );
  return rows.map((e) => ({
    event_id: e.id,
    title: e.title,
    starts_at: e.startsAt.toISOString(),
    ends_at: e.endsAt.toISOString(),
    source: e.source,
    busy: e.busy,
    activity_id: e.activityId,
  }));
}

export async function getAvailableSlots(
  input: ToolInput<"calendar.get_available_slots">,
): Promise<ToolOutput<"calendar.get_available_slots">> {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new PermanentError(`Invalid range: ${input.from} .. ${input.to}`);
  }

  const constraints = await resolveEffectiveConstraints(input.student_id, from);
  if (!constraints) return [];

  const blackout = new Set(constraints.blackoutDates);
  const weekly = constraints.weeklyAvailability as WeeklyAvailability;

  const busyEvents = await db
    .select({ startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.studentId, input.student_id),
        eq(calendarEvents.busy, true),
        gte(calendarEvents.endsAt, from),
        lte(calendarEvents.startsAt, to),
      ),
    );

  const energyWeights = await energyWeightByHour(input.student_id);
  const slots: ToolOutput<"calendar.get_available_slots"> = [];

  for (const day of eachUtcDayInRange(from, to)) {
    const dateKey = day.toISOString().slice(0, 10);
    if (blackout.has(dateKey)) continue;

    const windows = weekly[utcDayOfWeek(day)] ?? [];
    for (const w of windows) {
      let windowStart = wallClockToUtc(day, w.start);
      const windowEnd = wallClockToUtc(day, w.end);
      if (windowStart < from) windowStart = from;
      if (windowEnd <= windowStart || windowStart > to) continue;

      // Subtract busy overlaps within this window, splitting into free sub-ranges.
      const overlapping = busyEvents
        .filter((b) => overlaps(windowStart, windowEnd, b.startsAt, b.endsAt))
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

      let cursor = windowStart;
      const freeRanges: Array<{ start: Date; end: Date }> = [];
      for (const b of overlapping) {
        if (b.startsAt > cursor) freeRanges.push({ start: cursor, end: new Date(Math.min(b.startsAt.getTime(), windowEnd.getTime())) });
        if (b.endsAt > cursor) cursor = b.endsAt;
      }
      if (cursor < windowEnd) freeRanges.push({ start: cursor, end: windowEnd });

      for (const range of freeRanges) {
        const totalMin = minutesBetween(range.start, range.end);
        if (totalMin < input.min_slot_min) continue;

        // Split at max_session_min so no single slot exceeds it.
        let segStart = range.start;
        while (minutesBetween(segStart, range.end) >= input.min_slot_min) {
          const remaining = minutesBetween(segStart, range.end);
          const segMin = Math.min(constraints.maxSessionMin, remaining);
          const segEnd = new Date(segStart.getTime() + segMin * 60000);
          slots.push({
            start: segStart.toISOString(),
            end: segEnd.toISOString(),
            duration_min: segMin,
            energy_weight: energyWeights.get(segStart.getUTCHours()) ?? 1.0,
          });
          segStart = segEnd;
        }
      }
    }
  }

  return slots;
}

export async function createLearningSession(
  input: ToolInput<"calendar.create_learning_session">,
): Promise<ToolOutput<"calendar.create_learning_session">> {
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (end <= start) throw new PermanentError("Session end must be after start");

  const [activity] = await db
    .select({ studentId: learningActivities.studentId })
    .from(learningActivities)
    .where(eq(learningActivities.id, input.activity_id));
  if (!activity) throw new PermanentError(`Activity ${input.activity_id} not found`);

  const [row] = await db
    .insert(calendarEvents)
    .values({
      studentId: activity.studentId,
      title: input.title,
      startsAt: start,
      endsAt: end,
      source: "bloom",
      busy: true,
      activityId: input.activity_id,
    })
    .returning();

  return {
    event_id: row.id,
    title: row.title,
    starts_at: row.startsAt.toISOString(),
    ends_at: row.endsAt.toISOString(),
    source: row.source,
    busy: row.busy,
    activity_id: row.activityId,
  };
}

export async function modifyLearningSession(
  input: ToolInput<"calendar.modify_learning_session">,
): Promise<ToolOutput<"calendar.modify_learning_session">> {
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (end <= start) throw new PermanentError("Session end must be after start");

  const [existing] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, input.event_id));
  if (!existing) throw new PermanentError(`Calendar event ${input.event_id} not found`);
  if (existing.source !== "bloom") throw new PermanentError(`Event ${input.event_id} is external, not Bloom-owned`);

  const [row] = await db
    .update(calendarEvents)
    .set({ startsAt: start, endsAt: end })
    .where(eq(calendarEvents.id, input.event_id))
    .returning();

  return {
    event_id: row.id,
    title: row.title,
    starts_at: row.startsAt.toISOString(),
    ends_at: row.endsAt.toISOString(),
    source: row.source,
    busy: row.busy,
    activity_id: row.activityId,
  };
}

export async function deleteLearningSession(
  input: ToolInput<"calendar.delete_learning_session">,
): Promise<ToolOutput<"calendar.delete_learning_session">> {
  const [existing] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, input.event_id));
  if (!existing) throw new PermanentError(`Calendar event ${input.event_id} not found`);
  if (existing.source !== "bloom") throw new PermanentError(`Event ${input.event_id} is external, not Bloom-owned`);

  await db.delete(calendarEvents).where(eq(calendarEvents.id, input.event_id));
  return { event_id: input.event_id, deleted: true };
}
