/**
 * Turns calendar events plus constraints into a list of usable study slots
 * (bloom-phase4-brief §6). This project does not model student timezones —
 * every wall-clock string is UTC-normalised through src/lib/time.ts, the one
 * place that combines a day with a wall-clock string (see that file's
 * header). That sidesteps DST entirely: a UTC day is always exactly 24h.
 *
 * Two conventions that must never drift from calendar.ts / the validator:
 *  - all intervals are half-open [start, end) — see lib/time.ts `overlaps`.
 *  - all minute arithmetic happens on integer minutes via lib/time.ts
 *    `minutesBetween`; Dates are only constructed from that at the edges.
 */

import { SLOT } from "./constants.js";
import type { BusyInterval, Slot, StudentConstraintsInput } from "./types.js";
import { eachUtcDayInRange, isoDate, minutesBetween, overlaps, utcDayOfWeek, wallClockToUtc } from "../lib/time.js";

function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

/** Subtracts busy intervals from [windowStart, windowEnd), returning the free sub-ranges in order. */
function freeRangesWithin(windowStart: Date, windowEnd: Date, busyEvents: BusyInterval[]): Array<{ start: Date; end: Date }> {
  const overlapping = busyEvents
    .filter((b) => overlaps(windowStart, windowEnd, b.start, b.end))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const free: Array<{ start: Date; end: Date }> = [];
  let cursor = windowStart;
  for (const b of overlapping) {
    if (b.start.getTime() > cursor.getTime()) {
      free.push({ start: cursor, end: new Date(Math.min(b.start.getTime(), windowEnd.getTime())) });
    }
    if (b.end.getTime() > cursor.getTime()) cursor = b.end;
  }
  if (cursor.getTime() < windowEnd.getTime()) free.push({ start: cursor, end: windowEnd });
  return free;
}

/** Splits one free range into sessions no longer than maxSessionMin, leaving a gap between
 * split fragments. Fragments shorter than minSessionMin are dropped (including the whole
 * range, and any leftover tail that doesn't reach the minimum). */
function splitRange(start: Date, end: Date, minSessionMin: number, maxSessionMin: number): Array<{ start: Date; end: Date }> {
  const segments: Array<{ start: Date; end: Date }> = [];
  let cursor = start;
  while (minutesBetween(cursor, end) >= minSessionMin) {
    const remaining = minutesBetween(cursor, end);
    const segMin = Math.min(maxSessionMin, remaining);
    const segEnd = addMinutes(cursor, segMin);
    segments.push({ start: cursor, end: segEnd });
    if (segEnd.getTime() >= end.getTime()) break;
    cursor = addMinutes(segEnd, SLOT.split_gap_min);
  }
  return segments;
}

/** Caps one day's total scheduled minutes, trimming (truncating, then dropping) from the end
 * of the day so the earliest slots of the day are preserved untouched. */
function applyDailyCap(daySlots: Array<{ start: Date; end: Date }>, maxDailyStudyMin: number, minSessionMin: number): Array<{ start: Date; end: Date }> {
  const kept: Array<{ start: Date; end: Date }> = [];
  let usedMin = 0;
  for (const s of daySlots) {
    const remainingBudget = maxDailyStudyMin - usedMin;
    if (remainingBudget <= 0) break;
    const durationMin = minutesBetween(s.start, s.end);
    if (durationMin <= remainingBudget) {
      kept.push(s);
      usedMin += durationMin;
      continue;
    }
    if (remainingBudget >= minSessionMin) {
      kept.push({ start: s.start, end: addMinutes(s.start, remainingBudget) });
      usedMin += remainingBudget;
    }
    break;
  }
  return kept;
}

export function generateSlots(
  constraints: StudentConstraintsInput,
  busyEvents: BusyInterval[],
  from: Date,
  to: Date,
  completionByHour: Record<number, number>,
): Slot[] {
  const blackout = new Set(constraints.blackout_dates);
  const slots: Slot[] = [];

  for (const day of eachUtcDayInRange(from, to)) {
    if (blackout.has(isoDate(day))) continue;

    const windows = constraints.weekly_availability[utcDayOfWeek(day)] ?? [];
    const dayFragments: Array<{ start: Date; end: Date }> = [];

    for (const w of windows) {
      let windowStart = wallClockToUtc(day, w.start);
      let windowEnd = wallClockToUtc(day, w.end);
      if (windowStart.getTime() < from.getTime()) windowStart = from;
      if (windowEnd.getTime() > to.getTime()) windowEnd = to;
      if (windowEnd.getTime() <= windowStart.getTime()) continue;

      for (const free of freeRangesWithin(windowStart, windowEnd, busyEvents)) {
        for (const seg of splitRange(free.start, free.end, constraints.min_session_min, constraints.max_session_min)) {
          dayFragments.push(seg);
        }
      }
    }

    dayFragments.sort((a, b) => a.start.getTime() - b.start.getTime());
    const capped = applyDailyCap(dayFragments, constraints.max_daily_study_min, constraints.min_session_min);

    for (const seg of capped) {
      slots.push({
        start: seg.start,
        end: seg.end,
        duration_min: minutesBetween(seg.start, seg.end),
        energy_weight: completionByHour[seg.start.getUTCHours()] ?? SLOT.default_energy_weight,
      });
    }
  }

  return slots;
}
