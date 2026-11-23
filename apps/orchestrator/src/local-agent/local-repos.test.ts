import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeRemote, parseRepos, sameRemote } from './local-repos';
import { decodeFrame } from './local-agent-proto';

describe('remote addresses', () => {
  it('different spellings of one repository are equal', () => {
    const same = ['https://github.com/Acme/Shop.git', 'https://user:ghp_tok@GitHub.com/acme/shop/', 'git@github.com:acme/shop.git', 'ssh://git@github.com:22/acme/shop', 'http://github.com/acme/shop'];
    for (const a of same) for (const b of same) expect(sameRemote(a, b)).toBe(true);
    expect(normalizeRemote('git@github.com:Acme/Shop.git')).toBe('github.com/acme/shop');
  });
  it('different repositories, hosts and empty values are not equal', () => {
    expect(sameRemote('https://github.com/acme/shop', 'https://github.com/acme/shop2')).toBe(false);
    expect(sameRemote('https://github.com/acme/shop', 'https://gitlab.com/acme/shop')).toBe(false);
    expect(sameRemote('', '')).toBe(false);
    expect(sameRemote(null, 'https://github.com/a/b')).toBe(false);
    expect(sameRemote('not a url', 'not a url')).toBe(false);
  });
  it('a local remote keeps its path', () => {
    expect(sameRemote('file:///srv/git/shop.git', 'file:///srv/git/shop')).toBe(true);
    expect(sameRemote('file:///srv/git/shop.git', 'file:///srv/git/other.git')).toBe(false);
  });
});

describe('parseRepos', () => {
  it('reads the fixture the Go daemon is tested against', () => {
    const frame = decodeFrame(readFileSync(join(__dirname, '../../../../packages/shared/protocol/local-agent/event-repos.json'), 'utf8'))!;
    expect(frame).toMatchObject({ type: 'event', name: 'repos' });
    const repos = parseRepos(frame.data);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ id: 'a1b2c3d4', branch: 'main', ahead: 1, behind: 2, unstaged: 1, untracked: 1, origin: 'https://github.com/acme/shop.git' });
    expect(repos[0]!.files).toEqual([{ path: 'src/a.go', xy: '.M' }, { path: 'new.txt', xy: '??' }]);
  });
  it('drops what is not a status and caps sizes', () => {
    expect(parseRepos(null)).toEqual([]);
    expect(parseRepos({ repos: 'x' })).toEqual([]);
    expect(parseRepos({ repos: [null, 5, { id: 'zzzz' }, { id: 'a1b2c3d4', files: Array.from({ length: 500 }, (_, i) => ({ path: `f${i}`, xy: 'M.' })) }] })[0]!.files).toHaveLength(200);
    expect(parseRepos({ repos: Array.from({ length: 80 }, () => ({ id: 'a1b2c3d4' })) })).toHaveLength(50);
    const r = parseRepos({ repos: [{ id: 'a1b2c3d4', branch: 'x'.repeat(999), ahead: -5, behind: 'many', path: 'a\u0000b' }] })[0]!;
    expect(r.branch).toHaveLength(200);
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
    expect(r.path).toBe('ab');
  });
});
