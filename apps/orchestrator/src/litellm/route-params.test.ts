import { describe, expect, it } from 'vitest';
import { kindOf, routeParams } from './litellm.service';

describe('kindOf / routeParams', () => {
  it('uses the stored kind, else guesses from the base URL', () => {
    expect(kindOf({ kind: 'deepseek', baseUrl: 'https://api.anthropic.com' })).toBe('deepseek');
    expect(kindOf({ kind: '', baseUrl: 'https://api.openai.com/v1' })).toBe('openai');
    expect(kindOf({ kind: null, baseUrl: 'http://localhost:11434' })).toBe('ollama');
    expect(kindOf({ baseUrl: null })).toBe('anthropic');
  });
  it('builds the route params from a provider row', () => {
    expect(routeParams({ kind: 'openai', baseUrl: 'http://x', secret: 'k', rpm: 5, tpm: null })).toEqual({
      kind: 'openai', apiBase: 'http://x', apiKey: 'k', rpm: 5, tpm: null,
    });
    expect(routeParams({ kind: '', baseUrl: null, secret: null })).toMatchObject({ kind: 'anthropic', apiBase: null, apiKey: '' });
  });
});
