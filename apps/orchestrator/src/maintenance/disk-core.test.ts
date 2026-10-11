import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, GB, diskLevel, formatBytes, shouldNotify, thresholdsFromEnv } from './disk-core';

describe('diskLevel', () => {
  const total = 100 * GB;
  it('ok with plenty of room', () => expect(diskLevel(50 * GB, total)).toBe('ok'));
  it('warn below 15 % (at least 3 GB), critical below 7 % (at least 1 GB)', () => {
    expect(diskLevel(14 * GB, total)).toBe('warn');
    expect(diskLevel(6 * GB, total)).toBe('critical');
  });
  it('on a big disk the percentage is capped (warn under 20 GB, critical under 8 GB), on a tiny one an absolute floor holds', () => {
    expect(diskLevel(30 * GB, 500 * GB)).toBe('ok');
    expect(diskLevel(10 * GB, 500 * GB)).toBe('warn');
    expect(diskLevel(6 * GB, 500 * GB)).toBe('critical');
    expect(diskLevel(2 * GB, 20 * GB)).toBe('warn');
    expect(diskLevel(0.9 * GB, 20 * GB)).toBe('critical');
  });
  it('a filesystem with no size is not judged', () => expect(diskLevel(0, 0)).toBe('ok'));
});

describe('thresholdsFromEnv', () => {
  it('reads env, ignores junk, keeps critical <= warn', () => {
    expect(thresholdsFromEnv({})).toEqual(DEFAULT_THRESHOLDS);
    expect(thresholdsFromEnv({ DISK_WARN_PERCENT: '20', DISK_WARN_GB: '5' })).toMatchObject({ warnPercent: 20, warnBytes: 5 * GB });
    expect(thresholdsFromEnv({ DISK_WARN_PERCENT: 'x' })).toEqual(DEFAULT_THRESHOLDS);
    const t = thresholdsFromEnv({ DISK_WARN_PERCENT: '5', DISK_CRITICAL_PERCENT: '9' });
    expect(t.criticalPercent).toBe(5);
  });
});

describe('shouldNotify', () => {
  const H = 3_600_000;
  it('tells when it gets worse, then at most every 12 h; never when fine', () => {
    expect(shouldNotify('ok', 'warn', null, 0)).toBe(true);
    expect(shouldNotify('warn', 'warn', 0, 5 * H)).toBe(false);
    expect(shouldNotify('warn', 'warn', 0, 13 * H)).toBe(true);
    expect(shouldNotify('warn', 'critical', 1, 2)).toBe(true);
    expect(shouldNotify('critical', 'warn', 0, 1)).toBe(false);
    expect(shouldNotify('warn', 'ok', 0, 99 * H)).toBe(false);
  });
  it('formats sizes', () => {
    expect(formatBytes(2.5 * GB)).toBe('2.5 GB');
    expect(formatBytes(300 * 1024 ** 2)).toBe('300 MB');
  });
});
