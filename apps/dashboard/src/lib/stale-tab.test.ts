import { describe, expect, it } from 'vitest';
import { isStale } from './stale-tab';

describe('isStale', () => {
  it('a different server version than the one the page started with', () => expect(isStale('0.1.116', '0.1.120')).toBe(true));
  it('the same version, or a version that cannot be read, is not stale', () => {
    expect(isStale('0.1.120', '0.1.120')).toBe(false);
    expect(isStale(null, '0.1.120')).toBe(false);
    expect(isStale('0.1.120', null)).toBe(false);
    expect(isStale('0.1.120', '')).toBe(false);
  });
});
