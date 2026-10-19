import { afterEach, describe, expect, it } from 'vitest';
import { loginEnv, shq } from './login-process';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('loginEnv', () => {
  it('removes our own credentials but keeps the ones the caller passes on purpose', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ours';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ours-too';
    const env = loginEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'being-tested', CLAUDE_CONFIG_DIR: '/tmp/x' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('being-tested');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/x');
    expect(env.BROWSER).toBe('none');
  });
  it('with nothing passed no credential remains', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ours';
    expect(loginEnv({}).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('shq', () => {
  it('single-quotes a value for sh -c', () => {
    expect(shq("it's")).toBe("'it'\\''s'");
  });
});
