import { describe, expect, it } from 'vitest';
import { isValidScheduleName, describeSchedule, inQuietHours, isValidTimezone, nextRun, validateCron } from './schedule-core';

describe('nextRun', () => {
  it('evaluates in the given timezone (Kyiv is UTC+3 in October)', () => {
    expect(nextRun('30 9 * * *', 'Europe/Kyiv', new Date('2026-10-08T10:00:00Z')).toISOString()).toBe('2026-10-09T06:30:00.000Z');
  });
  it('is strictly after the given moment', () => {
    const t = new Date('2026-10-08T06:30:00Z');
    expect(nextRun('30 9 * * *', 'Europe/Kyiv', t).getTime()).toBeGreaterThan(t.getTime());
  });
  it('honours weekdays', () => {
    // 2026-10-10 is a Saturday -> next weekday run is Monday 12th
    expect(nextRun('0 8 * * 1-5', 'UTC', new Date('2026-10-10T12:00:00Z')).toISOString()).toBe('2026-10-12T08:00:00.000Z');
  });
});

describe('validateCron', () => {
  it('accepts normal schedules', () => {
    expect(validateCron('30 9 * * 1-5', 'Europe/Kyiv')).toBeNull();
    expect(validateCron('*/15 * * * *', 'UTC')).toBeNull();
  });
  it('rejects the wrong shape, bad timezones, junk and too-frequent runs', () => {
    expect(validateCron('every day', 'UTC')).toMatch(/5 fields/);
    expect(validateCron('* * * * * *', 'UTC')).toMatch(/5 fields/);
    expect(validateCron('30 9 * * *', 'Mars/Base')).toMatch(/timezone/);
    expect(validateCron('99 9 * * *', 'UTC')).toMatch(/not a valid/);
    expect(validateCron('* * * * *', 'UTC')).toMatch(/more often/);
    expect(validateCron('*/2 * * * *', 'UTC')).toMatch(/more often/);
  });
  it('knows timezones', () => {
    expect(isValidTimezone('Europe/Kyiv')).toBe(true);
    expect(isValidTimezone('Nope/Nope')).toBe(false);
  });
});

describe('inQuietHours', () => {
  const at = (iso: string) => new Date(iso);
  it('handles a window that wraps midnight', () => {
    // Kyiv = UTC+3: 21:00Z = 00:00 local (inside 22:00-08:00), 08:00Z = 11:00 local (outside)
    expect(inQuietHours(at('2026-10-08T21:00:00Z'), 'Europe/Kyiv', '22:00', '08:00')).toBe(true);
    expect(inQuietHours(at('2026-10-08T08:00:00Z'), 'Europe/Kyiv', '22:00', '08:00')).toBe(false);
  });
  it('handles a same-day window and the edges (end is exclusive)', () => {
    expect(inQuietHours(at('2026-10-08T10:00:00Z'), 'UTC', '09:00', '17:00')).toBe(true);
    expect(inQuietHours(at('2026-10-08T17:00:00Z'), 'UTC', '09:00', '17:00')).toBe(false);
  });
  it('no window / garbage = never quiet', () => {
    expect(inQuietHours(at('2026-10-08T10:00:00Z'), 'UTC', undefined, undefined)).toBe(false);
    expect(inQuietHours(at('2026-10-08T10:00:00Z'), 'UTC', '25:00', '08:00')).toBe(false);
    expect(inQuietHours(at('2026-10-08T10:00:00Z'), 'UTC', '08:00', '08:00')).toBe(false);
  });
});

describe('describeSchedule', () => {
  it.each([
    ['30 9 * * *', 'every day at 09:30'],
    ['0 8 * * 1-5', 'weekdays at 08:00'],
    ['0 18 * * 0', 'every Sunday at 18:00'],
    ['0 9 * * 1,3,5', 'Mon, Wed, Fri at 09:00'],
    ['0 9 1 * *', 'on day 1 of every month at 09:00'],
    ['*/30 * * * *', 'every 30 minutes'],
    ['15 */4 * * *', 'every 4 hours'],
    ['5 4 * 2 *', 'cron "5 4 * 2 *"'],
  ])('%s → %s', (cron, text) => {
    expect(describeSchedule(cron, 'Europe/Kyiv')).toContain(text);
  });
});

describe('isValidScheduleName', () => {
  it('accepts names in any language, with dashes and brackets', () => {
    for (const n of ['English — daily lesson', 'Английский утром', 'Ремонт: проверка (пн)', 'a', 'Weekly-review_2']) expect(isValidScheduleName(n), n).toBe(true);
  });
  it('rejects empty, too long, leading punctuation and markup', () => {
    for (const n of ['', '   ', 'x'.repeat(61), '- starts with a dash', '<script>', 'a/b', 'new\nline']) expect(isValidScheduleName(n), JSON.stringify(n)).toBe(false);
  });
});
