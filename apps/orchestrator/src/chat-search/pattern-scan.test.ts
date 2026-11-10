import { describe, expect, it } from 'vitest';
import { checkPattern, snippetFromRanges, unicodeAware } from './search-core';
import { scanTexts } from './pattern-scan';

describe('checkPattern', () => {
  it('accepts a valid pattern; refuses empty, too long and invalid ones with a reason', () => {
    expect(checkPattern('лит\\w+')).toEqual({ ok: true });
    expect(checkPattern('  ')).toMatchObject({ ok: false });
    expect(checkPattern('a'.repeat(201))).toMatchObject({ ok: false, error: expect.stringContaining('too long') });
    expect(checkPattern('(unclosed')).toEqual({ ok: false, error: 'not a valid pattern: Unterminated group' });
  });
});

describe('snippetFromRanges', () => {
  it('marks the given ranges; cuts a long text around the first one', () => {
    const s = snippetFromRanges('abc 2026-11-10 def', [[4, 14]]);
    expect(s.marks.map(([a, b]) => s.text.slice(a, b))).toEqual(['2026-11-10']);
    const long = `${'x '.repeat(200)}2026-11-10 ${'y '.repeat(200)}`;
    const i = long.indexOf('2026');
    const c = snippetFromRanges(long, [[i, i + 10]]);
    expect(c.text.length).toBeLessThan(260);
    expect(c.marks.map(([a, b]) => c.text.slice(a, b))).toEqual(['2026-11-10']);
  });
});

describe('scanTexts (a worker with a time limit)', () => {
  it('finds the matches of a pattern, case-insensitively, in any script', async () => {
    const r = await scanTexts(unicodeAware('лит\\w+|\\d{4}-\\d{2}-\\d{2}'), ['В Литве бонусы', 'nothing', 'on 2026-11-10 ok'], 3000);
    expect(r.timedOut).toBe(false);
    expect([...r.found.entries()]).toEqual([
      [0, [[2, 7]]],
      [2, [[3, 13]]],
    ]);
  });
  it('a pattern that would backtrack for ever is stopped at the time limit, and the server goes on', async () => {
    const t0 = Date.now();
    const r = await scanTexts('(a+)+$', [`${'a'.repeat(40)}b`], 400);
    expect(r.timedOut).toBe(true);
    expect(r.found.size).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('an empty-match pattern does not hang and reports no matches', async () => {
    const r = await scanTexts('x*', ['abc'], 2000);
    expect(r.timedOut).toBe(false);
    expect(r.found.size).toBe(0);
  });
});

describe('unicodeAware', () => {
  const m = (pat: string, text: string) => [...text.matchAll(new RegExp(unicodeAware(pat), 'giu'))].map((x) => x[0]);
  it('\\w, \\W and \\b know every script', () => {
    expect(m('лит\\w+', 'В Литве и Литвы')).toEqual(['Литве', 'Литвы']);
    expect(m('\\bбонус\\w*', 'налоговый бонус, бонусы, небонус')).toEqual(['бонус', 'бонусы']);
    expect(m('\\w+\\W', 'ab cd')).toEqual(['ab ']);
  });
  it('inside a class \\w is the letters, digits and underscore of any script; other escapes stay', () => {
    expect(m('[\\w-]+', 'e-mail, привет-мир')).toEqual(['e-mail', 'привет-мир']);
    expect(m('\\d+\\.\\d+', 'v 1.25')).toEqual(['1.25']);
  });
});
