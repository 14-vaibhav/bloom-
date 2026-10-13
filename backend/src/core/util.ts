import { startOfUtcDay } from "../lib/time.js";

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/** True when `a` and `b` fall on different UTC calendar days. */
export function isDifferentCalendarDay(a: Date, b: Date): boolean {
  return startOfUtcDay(a).getTime() !== startOfUtcDay(b).getTime();
}
