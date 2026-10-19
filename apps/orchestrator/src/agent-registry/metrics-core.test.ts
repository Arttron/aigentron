import { describe, expect, it } from 'vitest';
import { clampDays, groupTop, humanSeconds, mdTable, normalizeText, pct, percentile, secondsBetween } from './metrics-core';

describe('groupTop', () => {
  it('counts, ranks and shares', () => {
    const g = groupTop(['a', 'b', 'a', 'c', 'a', 'b'], (x) => x, 2);
    expect(g).toEqual([
      { key: 'a', count: 3, share: 0.5 },
      { key: 'b', count: 2, share: 2 / 6 },
    ]);
  });
  it('ties are ordered by name, an empty list is empty', () => {
    expect(groupTop(['b', 'a'], (x) => x).map((g) => g.key)).toEqual(['a', 'b']);
    expect(groupTop([], (x) => x)).toEqual([]);
  });
});

describe('percentile / durations', () => {
  it('nearest-rank percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
  });
  it('humanises seconds and dates', () => {
    expect(humanSeconds(null)).toBe('—');
    expect(humanSeconds(42)).toBe('42 s');
    expect(humanSeconds(600)).toBe('10 min');
    expect(humanSeconds(3700)).toBe('1 h 2 min');
    expect(secondsBetween(new Date(0), new Date(5000))).toBe(5);
    expect(secondsBetween(null, new Date())).toBeNull();
    expect(pct(0.456)).toBe('46%');
  });
});

describe('normalizeText', () => {
  it('blurs ids, long paths and numbers so equal requests group', () => {
    expect(normalizeText('rm -rf /opt/aigentron/data/projects/web/work/run-123456')).toBe('rm -rf <path>');
    expect(normalizeText('task cmvfk6ph80008izp8qr4l15ee failed after 40000 ms')).toBe('task <id> failed after <n> ms');
    expect(normalizeText('a   b\n c')).toBe('a b c');
  });
});

describe('mdTable / clampDays', () => {
  it('builds a Markdown table and escapes pipes', () => {
    expect(mdTable(['A', 'B'], [['x|y', 2]])).toBe('| A | B |\n|---|---|\n| x\\|y | 2 |');
  });
  it('days stay within 1–365', () => {
    expect([clampDays(undefined), clampDays(0), clampDays(9999), clampDays(30.4)]).toEqual([7, 1, 365, 30]);
  });
});
