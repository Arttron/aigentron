import { describe, expect, it } from 'vitest';
import { publicOrigin, resolveCorsOrigin } from './cors';

describe('publicOrigin', () => {
  it('keeps only the origin and rejects junk', () => {
    expect(publicOrigin('https://dev.example.com/some/path')).toBe('https://dev.example.com');
    expect(publicOrigin('ftp://x')).toBeNull();
    expect(publicOrigin('nonsense')).toBeNull();
    expect(publicOrigin(undefined)).toBeNull();
  });
});

describe('resolveCorsOrigin', () => {
  it('defaults to localhost only', () => {
    const o = resolveCorsOrigin(undefined, undefined) as (string | RegExp)[];
    expect(o).toHaveLength(2);
  });
  it('adds PUBLIC_URL as the single extra default origin', () => {
    const o = resolveCorsOrigin(undefined, 'https://dev.example.com/') as (string | RegExp)[];
    expect(o).toContain('https://dev.example.com');
  });
  it('an explicit CORS_ORIGINS wins', () => {
    expect(resolveCorsOrigin('https://a.dev, https://b.dev', 'https://c.dev')).toEqual(['https://a.dev', 'https://b.dev']);
    expect(resolveCorsOrigin('*', undefined)).toBe(true);
  });
});
