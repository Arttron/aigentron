import { describe, expect, it } from 'vitest';
import { isOutdated } from './extension.controller';

describe('isOutdated', () => {
  it('older than the shipped version, compared numerically', () => {
    expect(isOutdated('0.1.99', '0.1.104')).toBe(true);
    expect(isOutdated('0.1.104', '0.1.104')).toBe(false);
    expect(isOutdated('0.2.0', '0.1.104')).toBe(false);
    expect(isOutdated('1.0', '1.0.1')).toBe(true);
  });
  it('an unknown version or nothing shipped is never outdated', () => {
    expect(isOutdated(undefined, '0.1.104')).toBe(false);
    expect(isOutdated(null, '0.1.104')).toBe(false);
    expect(isOutdated('0.1.1', undefined)).toBe(false);
    expect(isOutdated('0.1.1', 'dev')).toBe(false);
  });
});
