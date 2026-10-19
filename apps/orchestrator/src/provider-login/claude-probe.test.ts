import { describe, expect, it } from 'vitest';
import { readClaudeProbe } from './claude-probe';

describe('readClaudeProbe', () => {
  it('a good run is ok with the reply', () => {
    expect(readClaudeProbe(JSON.stringify({ type: 'result', is_error: false, result: 'OK' }))).toEqual({ ok: true, reply: 'OK' });
  });
  it('an API error is reported in the CLI’s own words', () => {
    expect(readClaudeProbe(JSON.stringify({ is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }))).toEqual({
      ok: false,
      error: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
    });
    expect(readClaudeProbe(JSON.stringify({ is_error: true, api_error_status: 429 })).error).toContain('429');
  });
  it('output that is not JSON is an error with its tail, never a throw', () => {
    expect(readClaudeProbe('boom\nsomething broke').ok).toBe(false);
    expect(readClaudeProbe('').error).toContain('no result');
  });
});
