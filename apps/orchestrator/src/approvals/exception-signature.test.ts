import { describe, expect, it } from 'vitest';
import { argsHash, canonicalJson, exceptionCutoff, exceptionSignature, exceptionTtlDays } from './exception-signature';

describe('exception signatures', () => {
  it('canonicalJson ignores key order, also nested', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it('argsHash is stable and sensitive to values', () => {
    expect(argsHash({ x: 1, y: 2 })).toBe(argsHash({ y: 2, x: 1 }));
    expect(argsHash({ x: 1 })).not.toBe(argsHash({ x: 2 }));
  });
  it('MCP calls are bound to their arguments; other tools to the summary only', () => {
    const a = exceptionSignature('mcp__db__query', 'mcp__db__query', { sql: 'select 1' });
    const b = exceptionSignature('mcp__db__query', 'mcp__db__query', { sql: 'drop table users' });
    expect(a).not.toBe(b);
    expect(exceptionSignature('Bash', 'rm -rf x', { command: 'rm -rf x' })).toBe('rm -rf x');
  });
});

describe('exception TTL', () => {
  it('defaults to 30 days, 0/negative = never, garbage = default', () => {
    expect(exceptionTtlDays(undefined)).toBe(30);
    expect(exceptionTtlDays('7')).toBe(7);
    expect(exceptionTtlDays('0')).toBe(0);
    expect(exceptionTtlDays('-1')).toBeLessThanOrEqual(0);
    expect(exceptionTtlDays('abc')).toBe(30);
  });
  it('cutoff is null when never expiring, else now − ttl', () => {
    expect(exceptionCutoff(0)).toBeNull();
    const now = Date.UTC(2026, 0, 31);
    expect(exceptionCutoff(30, now)?.toISOString()).toBe(new Date(Date.UTC(2026, 0, 1)).toISOString());
  });
});
