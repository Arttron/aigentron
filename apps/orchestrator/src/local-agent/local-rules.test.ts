import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, normalizeRules } from './local-rules';

const DIR = join(__dirname, '../../../../packages/shared/protocol/local-agent/rules');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as T;

// The same fixtures the Go daemon tests (apps/local-agent/internal/rules): the two sides must give the same answers.
describe('the rules contract (shared with the Go daemon)', () => {
  it('the defaults equal the fixture', () => expect(DEFAULT_RULES).toEqual(load('defaults.json')));

  const valid = load<{ name: string; rules: unknown; normalized: unknown }[]>('valid.json');
  it.each(valid.map((c) => [c.name, c] as const))('accepts and normalizes: %s', (_n, c) => {
    const r = normalizeRules(c.rules);
    expect(r).toEqual({ ok: true, rules: c.normalized });
  });

  const invalid = load<{ name: string; rules: unknown }[]>('invalid.json');
  it('the invalid fixture is not tiny', () => expect(invalid.length).toBeGreaterThanOrEqual(10));
  it.each(invalid.map((c) => [c.name, c] as const))('rejects: %s', (_n, c) => {
    const r = normalizeRules(c.rules);
    expect(r.ok).toBe(false);
  });

  it('nothing sent = the defaults, and the defaults are not shared state', () => {
    const r = normalizeRules(undefined);
    expect(r).toEqual({ ok: true, rules: DEFAULT_RULES });
    if (r.ok) r.rules.ignore.push('x');
    expect(DEFAULT_RULES.ignore).toEqual([]);
  });
  it('says what is wrong', () => {
    expect(normalizeRules({ snapshot: { idleMinutes: 0 } })).toMatchObject({ ok: false, error: expect.stringContaining('between 1 and 120') });
    expect(normalizeRules({ autoPush: {} })).toMatchObject({ ok: false, error: expect.stringContaining('autoPush') });
  });
});
