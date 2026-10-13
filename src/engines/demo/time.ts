// c106 — small pure date helpers for the demo seed. Demo dates are always
// relative to "now", so a freshly reset demo firm looks current.

import { fromLocal, toLocal } from "@/core/businessHours";

const DAY_MS = 86_400_000;

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

/** 'YYYY-MM-DD' in UTC. */
export function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The given local hour on the same local calendar day as `at`, moved forward
 * to Monday when that day is a weekend (court dates are weekday events).
 */
export function atLocalHour(at: Date, hour: number, timeZone: string): Date {
  let l = toLocal(at, timeZone);
  let candidate = fromLocal(l.year, l.month, l.day, hour, 0, timeZone);
  for (let i = 0; i < 3; i++) {
    const weekday = new Date(Date.UTC(l.year, l.month - 1, l.day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) break;
    l = toLocal(addDays(candidate, 1), timeZone);
    candidate = fromLocal(l.year, l.month, l.day, hour, 0, timeZone);
  }
  return candidate;
}

/** 'YYYY-MM' of the calendar month before `at` (UTC). */
export function previousMonth(at: Date): string {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth(); // 0-based current month = 1-based previous month
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, "0")}`;
}

/** First and last day ('YYYY-MM-DD') of a 'YYYY-MM' period. */
export function monthBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, "0")}` };
}
