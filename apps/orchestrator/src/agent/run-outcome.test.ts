import { describe, expect, it } from 'vitest';
import { errorTextOf, isFailoverWorthy, reportText, shortReason, tagSessionId, untagSessionId } from './run-outcome';

describe('isFailoverWorthy (existing behaviour)', () => {
  it('is false for an empty message and for clean results', () => {
    expect(isFailoverWorthy('')).toBe(false);
    expect(isFailoverWorthy('Done. I pushed the branch.')).toBe(false);
  });
  it('is false for orchestrator-driven stops even when they look like provider errors', () => {
    expect(isFailoverWorthy('agent run aborted')).toBe(false);
    expect(isFailoverWorthy('request timed out: ECONNRESET')).toBe(false);
  });
  it.each([
    'connect ECONNREFUSED 127.0.0.1:4000',
    'fetch failed',
    'rate limit exceeded, retry later',
    'Internal Server Error',
    '401 unauthorized',
    'API Error: 529 overloaded',
    'HTTP 503',
    'status code 429',
    'model claude-x not found',
    'This model does not support tools',
    'Codex is not signed in — sign in with ChatGPT',
    'failed to start codex: spawn codex ENOENT',
  ])('fails over on %j', (m) => expect(isFailoverWorthy(m)).toBe(true));
  it('does not fire on bare digits in paths or diffs', () => {
    expect(isFailoverWorthy('edited src/errors/500.html and tests/403_page.spec.ts')).toBe(false);
    expect(isFailoverWorthy('the answer is 429')).toBe(false);
  });
  it('does not fire on the step limit', () => {
    expect(isFailoverWorthy('Reached maximum number of turns (40)')).toBe(false);
  });
});

describe('shortReason / errorTextOf', () => {
  it('collapses whitespace and caps at 80 chars', () => {
    expect(shortReason('  a \n b ')).toBe('a b');
    expect(shortReason('')).toBe('provider error');
    expect(shortReason('x'.repeat(100))).toBe(`${'x'.repeat(80)}…`);
  });
  it('errorTextOf keeps one paragraph of up to 500 chars, undefined when empty', () => {
    expect(errorTextOf(undefined)).toBeUndefined();
    expect(errorTextOf('  \n ')).toBeUndefined();
    expect(errorTextOf('API Error: 401\n{"type":"error"}')).toBe('API Error: 401 {"type":"error"}');
    expect(errorTextOf('y'.repeat(600))).toHaveLength(501);
  });
});

describe('reportText', () => {
  it('returns the summary, the handoff, both, or null', () => {
    expect(reportText({ status: 'done', summary: 'Pushed.' })).toBe('Pushed.');
    expect(reportText({ status: 'blocked', handoff: 'Which DB?' })).toBe('Which DB?');
    expect(reportText({ status: 'blocked', summary: 'Half done.', handoff: 'Which DB?' })).toBe('Half done.\n\nNeeds from a human: Which DB?');
    expect(reportText({ status: 'done', summary: '  ' })).toBeNull();
  });
});

describe('session id tagging', () => {
  it('tags codex ids and leaves claude ids alone', () => {
    expect(tagSessionId('abc', true)).toBe('codex:abc');
    expect(tagSessionId('abc', false)).toBe('abc');
    expect(tagSessionId(null, true)).toBeNull();
  });
  it('only resumes a session of the same runtime', () => {
    expect(untagSessionId('codex:abc', true)).toBe('abc');
    expect(untagSessionId('codex:abc', false)).toBeUndefined();
    expect(untagSessionId('abc', false)).toBe('abc');
    expect(untagSessionId('abc', true)).toBeUndefined();
    expect(untagSessionId(undefined, true)).toBeUndefined();
  });
});
