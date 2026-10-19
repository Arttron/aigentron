import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_SLUG,
  effectiveIsolation,
  impliedRepoAuth,
  isValidSlug,
  normalizeBranch,
  normalizeSubdir,
  parseRepoUrl,
  redactRepoUrl,
  slugFromName,
  slugProblem,
  uniqueSlug,
} from './project-core';

describe('slugs', () => {
  it('accepts the folder-name alphabet and nothing else', () => {
    for (const ok of ['a', 'my-project', 'p2', '0abc', 'a'.repeat(40)]) expect(isValidSlug(ok)).toBe(true);
    for (const bad of ['', '-a', 'A', 'my project', 'a_b', 'a.b', 'a/b', 'a'.repeat(41), 'ё']) expect(isValidSlug(bad)).toBe(false);
  });
  it('reserves "default" (and the platform folder names) for new projects', () => {
    expect(slugProblem(DEFAULT_PROJECT_SLUG)).toMatch(/reserved/);
    expect(slugProblem('trash')).toMatch(/reserved/);
    expect(slugProblem('shop')).toBeNull();
    expect(slugProblem('Shop')).toMatch(/lowercase/);
  });
  it('derives an ascii slug from a unicode name', () => {
    expect(slugFromName('Кухня 2')).toBe('kukhnya-2');
    expect(slugFromName('  Shop   Backend (v2) ')).toBe('shop-backend-v2');
    expect(slugFromName('Ελληνικά')).toBe('ellinika');
    expect(slugFromName('日本語')).toBe('project');
    expect(slugFromName('')).toBe('project');
    expect(slugFromName('---')).toBe('project');
    const long = slugFromName('x'.repeat(60) + ' tail');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(isValidSlug(long)).toBe(true);
  });
  it('picks a free slug with a numeric suffix, within the length limit', () => {
    const taken = new Set(['shop', 'shop-2', 'default-2']);
    expect(uniqueSlug('shop', (s) => taken.has(s))).toBe('shop-3');
    expect(uniqueSlug('other', (s) => taken.has(s))).toBe('other');
    expect(uniqueSlug('default', (s) => taken.has(s))).toBe('default-3');
    const long = uniqueSlug('a'.repeat(40), () => false);
    expect(long).toBe('a'.repeat(40));
    const longTaken = uniqueSlug('a'.repeat(40), (s) => s === 'a'.repeat(40));
    expect(longTaken).toBe('a'.repeat(38) + '-2');
  });
});

describe('repository URLs', () => {
  it('classifies https, ssh:// and scp-like URLs and finds owner/repo and the provider', () => {
    expect(parseRepoUrl('https://github.com/acme/widgets.git')).toMatchObject({ protocol: 'https', host: 'github.com', owner: 'acme', repo: 'widgets', provider: 'github', hadCredentials: false });
    expect(parseRepoUrl('https://gitlab.com/group/sub/repo')).toMatchObject({ protocol: 'https', host: 'gitlab.com', owner: 'group/sub', repo: 'repo', provider: 'gitlab' });
    expect(parseRepoUrl('git@github.com:acme/widgets.git')).toMatchObject({ protocol: 'ssh', host: 'github.com', owner: 'acme', repo: 'widgets', provider: 'github' });
    expect(parseRepoUrl('ssh://git@bitbucket.org:7999/team/repo.git')).toMatchObject({ protocol: 'ssh', host: 'bitbucket.org', owner: 'team', repo: 'repo', provider: 'bitbucket' });
    expect(parseRepoUrl('https://git.example.com/x/y.git')).toMatchObject({ provider: 'generic', owner: 'x', repo: 'y' });
    expect(parseRepoUrl('https://gitlab.example.com/x/y')).toMatchObject({ provider: 'gitlab' });
    expect(parseRepoUrl('file:///srv/git/repo.git')).toMatchObject({ protocol: 'file', owner: null, repo: null });
  });
  it('rejects what is not a repository URL', () => {
    for (const bad of ['', 'not a url', 'ftp://x/y', 'github.com/acme/widgets', 'git@github.com', 'https://', 'https://github.com/acme/widgets with space']) {
      expect(parseRepoUrl(bad), bad).toBeNull();
    }
  });
  it('notices and strips embedded credentials', () => {
    const p = parseRepoUrl('https://x-access-token:ghp_abc@github.com/acme/widgets.git');
    expect(p?.hadCredentials).toBe(true);
    expect(p?.url).toBe('https://github.com/acme/widgets.git');
    expect(redactRepoUrl('https://user:pw@host/a/b')).toBe('https://host/a/b');
    expect(redactRepoUrl('git@github.com:acme/widgets.git')).toBe('git@github.com:acme/widgets.git');
    expect(redactRepoUrl('https://github.com/acme/widgets.git')).toBe('https://github.com/acme/widgets.git');
  });
  it('implies ssh auth for ssh URLs only', () => {
    expect(impliedRepoAuth(parseRepoUrl('git@github.com:a/b.git'))).toBe('ssh');
    expect(impliedRepoAuth(parseRepoUrl('https://github.com/a/b'))).toBe('none');
    expect(impliedRepoAuth(null)).toBe('none');
  });
});

describe('defaults and normalisation', () => {
  it('isolation follows WORKSPACE_SHARED unless the project says', () => {
    expect(effectiveIsolation(null, true)).toBe('shared');
    expect(effectiveIsolation(null, false)).toBe('worktree');
    expect(effectiveIsolation('worktree', true)).toBe('worktree');
    expect(effectiveIsolation('bogus', true)).toBe('shared');
  });
  it('subdir stays inside the repository', () => {
    expect(normalizeSubdir(' packages/api/ ')).toBe('packages/api');
    expect(normalizeSubdir('/abs')).toBe('abs');
    expect(normalizeSubdir('../x')).toBe('');
    expect(normalizeSubdir('a//b')).toBe('');
    expect(normalizeSubdir(null)).toBe('');
  });
  it('branch names: the usual ones pass, the impossible ones do not', () => {
    expect(normalizeBranch(' main ')).toBe('main');
    expect(normalizeBranch('feature/x-1')).toBe('feature/x-1');
    for (const bad of ['', 'a b', 'a..b', '-x', '/x', 'x/', 'x.lock', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b']) expect(normalizeBranch(bad), bad).toBeNull();
  });
});
