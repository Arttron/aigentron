import { describe, expect, it } from 'vitest';
import { gitAuthEnv, parseGithubRepo, redactUrl } from './git-auth';

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
