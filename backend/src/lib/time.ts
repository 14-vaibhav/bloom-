/**
 * Bloom does not model student timezones — every wall-clock string in
 * student_constraints.weekly_availability ("18:00") is UTC-normalized on the
 * day it applies to. This is the one function that combines a day with a
 * wall-clock string; never inline that arithmetic anywhere else.
 */

export function wallClockToUtc(day: Date, wallClock: string): Date {
  const [h, m] = wallClock.split(":").map(Number);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m, 0, 0));
}

export function utcToWallClock(instant: Date): string {
  const h = String(instant.getUTCHours()).padStart(2, "0");
  const m = String(instant.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function eachUtcDayInRange(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  let cursor = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/** day-of-week key used by weekly_availability, matching JS getUTCDay(): 0=Sun..6=Sat */
export function utcDayOfWeek(d: Date): string {
  return String(d.getUTCDay());
}
