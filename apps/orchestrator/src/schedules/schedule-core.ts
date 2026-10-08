/**
 * Pure scheduling helpers (cron next-run, validation, quiet hours, a human description). No Nest, no I/O — unit-tested.
 */
import { CronExpressionParser } from 'cron-parser';

/** Runs closer together than this are refused (a typo like `* * * * *` must not hammer a model or a chat). */
export const MIN_INTERVAL_MINUTES = 5;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The next time `cron` fires strictly after `after`, evaluated in `tz`. */
export function nextRun(cron: string, tz: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { tz, currentDate: after }).next().toDate();
}

/** Why this cron/timezone pair is unusable (null = fine). */
export function validateCron(cron: string, tz: string): string | null {
  const c = cron.trim().replace(/\s+/g, ' ');
  if (c.split(' ').length !== 5) return 'a schedule is 5 fields: minute hour day-of-month month day-of-week (e.g. "30 9 * * 1-5").';
  if (!isValidTimezone(tz)) return `unknown timezone "${tz}" (use e.g. Europe/Kyiv, America/New_York, UTC).`;
  try {
    const it = CronExpressionParser.parse(c, { tz, currentDate: new Date() });
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    if (b - a < MIN_INTERVAL_MINUTES * 60_000) return `it would run more often than every ${MIN_INTERVAL_MINUTES} minutes.`;
  } catch (e) {
    return `not a valid schedule (${(e as Error).message}).`;
  }
  return null;
}

import { isHM } from '@lds/shared';
export { isHM };

/** Local wall-clock minutes since midnight in `tz`. */
export function minutesOfDay(date: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0);
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** Is `date` inside the quiet window [start, end) in `tz`? The window may wrap past midnight (22:00–08:00). */
export function inQuietHours(date: Date, tz: string, start?: string | null, end?: string | null): boolean {
  if (!start || !end || !isHM(start) || !isHM(end)) return false;
  const toMin = (s: string) => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]);
  const s = toMin(start);
  const e = toMin(end);
  if (s === e) return false;
  const now = minutesOfDay(date, tz);
  return s < e ? now >= s && now < e : now >= s || now < e;
}

export { describeSchedule } from '@lds/shared';

/** Letters/digits of ANY language plus space and ._-–—:() — "Английский утром" and "English — daily lesson" are fine. 1–60 characters. */
const NAME = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} ._\-–—:()]{0,59}$/u;
export const isValidScheduleName = (name: string): boolean => NAME.test(name.trim());
