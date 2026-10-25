import { describe, expect, it } from 'vitest';
import { axisTicks, parseHidden, shownTokens } from './stats-view';

describe('stats view', () => {
  it('the hidden columns come back from storage, junk dropped', () => {
    expect([...parseHidden(['inputTokens', 'nope', 3, 'cacheTokens'])]).toEqual(['inputTokens', 'cacheTokens']);
    expect(parseHidden('x').size).toBe(0);
    expect(parseHidden(null).size).toBe(0);
  });
  it('switched-off token series do not count towards what is shown', () => {
    const u = { inputTokens: 100, outputTokens: 10, cacheTokens: 1000 };
    expect(shownTokens(u, new Set())).toBe(1110);
    expect(shownTokens(u, new Set(['cacheTokens'] as const))).toBe(110);
    expect(shownTokens(u, new Set(['inputTokens', 'outputTokens', 'cacheTokens'] as const))).toBe(0);
  });
  it('the axis labels the first day, the last, and every week between', () => {
    expect(axisTicks(0)).toEqual([]);
    expect(axisTicks(1)).toEqual([0]);
    expect(axisTicks(15)).toEqual([0, 7, 14]);
    expect(axisTicks(12)).toEqual([0, 7, 11]);
    expect(axisTicks(11)).toEqual([0, 7]); // the last is too close to the previous to label
  });
});
