import { describe, expect, it } from 'vitest';
import { anonymousAuth, gitAuthEnv, needsHttpCredentials, parseGithubRepo, redactUrl, tokenAuth } from './git-auth';

describe('gitAuthEnv', () => {
  it('resets the persisted http.extraHeader before adding the token (no duplicate Authorization)', () => {
    const env = gitAuthEnv('ghp_secret', { PATH: '/usr/bin' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    // entry 0: an empty value → git clears the multi-valued list it read from .git/config
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    // entry 1: exactly one Authorization header with the token
    expect(env.GIT_CONFIG_KEY_1).toBe('http.extraHeader');
    expect(env.GIT_CONFIG_VALUE_1).toBe(`AUTHORIZATION: Basic ${Buffer.from('x-access-token:ghp_secret').toString('base64')}`);
    expect(Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_'))).toHaveLength(5);
  });

  it('passes the environment through untouched without a token', () => {
    const base = { PATH: '/usr/bin' };
    expect(gitAuthEnv(undefined, base)).toBe(base);
    expect(gitAuthEnv(null, base)).toBe(base);
    expect(gitAuthEnv('', base)).toBe(base);
    expect(Object.keys(gitAuthEnv(undefined, base))).not.toContain('GIT_CONFIG_COUNT');
  });

  it('never puts the raw token into argv-visible places (only the env, base64-encoded)', () => {
    const env = gitAuthEnv('ghp_secret', {});
    expect(JSON.stringify(env)).not.toContain('ghp_secret');
  });
});

describe('redactUrl / parseGithubRepo', () => {
  it('strips embedded credentials from a URL', () => {
    expect(redactUrl('https://x-access-token:ghp_1@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(redactUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
  });
  it('parses owner/repo from https and ssh forms', () => {
    expect(parseGithubRepo('https://github.com/Owner/Repo.git')).toEqual({ owner: 'Owner', repo: 'Repo' });
    expect(parseGithubRepo('https://github.com/Owner/Repo/')).toEqual({ owner: 'Owner', repo: 'Repo' });
    expect(parseGithubRepo('git@github.com:Owner/Repo.git')).toEqual({ owner: 'Owner', repo: 'Repo' });
    expect(parseGithubRepo('https://gitlab.com/o/r.git')).toBeNull();
  });
});

describe('tokenAuth / anonymousAuth (the GIT_CREDENTIALS shapes)', () => {
  it('a token auth carries the header in the env, redacts the token and its base64 form, never prompts', () => {
    const a = tokenAuth('ghp_secret');
    expect(a.anonymous).toBe(false);
    expect(a.args).toEqual([]);
    expect(a.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(a.env.GIT_CONFIG_VALUE_1).toContain('AUTHORIZATION: Basic ');
    const basic = Buffer.from('x-access-token:ghp_secret').toString('base64');
    expect(a.redact(`fatal: https://x:ghp_secret@github.com ${basic} end`)).toBe('fatal: https://x:***@github.com *** end');
    expect(JSON.stringify(a.env)).not.toContain('ghp_secret');
  });
  it('an anonymous auth adds nothing but the no-prompt flag', () => {
    const a = anonymousAuth();
    expect(a).toMatchObject({ anonymous: true, args: [], env: { GIT_TERMINAL_PROMPT: '0' } });
    expect(a.redact('x')).toBe('x');
  });
  it('needsHttpCredentials: https/http only', () => {
    expect(needsHttpCredentials('https://github.com/o/r.git')).toBe(true);
    expect(needsHttpCredentials('git@github.com:o/r.git')).toBe(false);
    expect(needsHttpCredentials('file:///tmp/bare.git')).toBe(false);
    expect(needsHttpCredentials('ssh://git@host/o/r.git')).toBe(false);
  });
});
