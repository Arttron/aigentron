import { describe, expect, it } from 'vitest';
import type { Project } from '@lds/shared';
import { deployKeyPlace, formatDuration, pickProject, previewSlug, providerTokenPage, relativeTime, repoLabel, repoLine, selectableProjects, slugFromName, stepMark, stepTone, testSummary } from './projects';

describe('slug preview', () => {
  it('transliterates unicode names like the server', () => {
    expect(slugFromName('Кухня 2')).toBe('kukhnya-2');
    expect(slugFromName('  Café  Ñandú! ')).toBe('cafe-nandu');
    expect(slugFromName('Hello, World')).toBe('hello-world');
  });
  it('falls back to "project" when nothing is readable and caps the length', () => {
    expect(slugFromName('日本語')).toBe('project');
    expect(slugFromName('')).toBe('project');
    expect(slugFromName('a'.repeat(60))).toHaveLength(40);
  });
  it('adds -2, -3 when taken or reserved', () => {
    expect(previewSlug('Docs', ['docs'])).toBe('docs-2');
    expect(previewSlug('Docs', ['docs', 'docs-2'])).toBe('docs-3');
    expect(previewSlug('Default', [])).toBe('default-2');
  });
});

describe('repository labels', () => {
  it('reads https, ssh:// and scp-like addresses', () => {
    expect(repoLabel('https://github.com/org/app.git')).toEqual({ host: 'github.com', short: 'org/app', provider: 'github' });
    expect(repoLabel('git@gitlab.com:team/sub/app.git')).toEqual({ host: 'gitlab.com', short: 'team/sub/app', provider: 'gitlab' });
    expect(repoLabel('ssh://git@bitbucket.org/o/r.git')?.provider).toBe('bitbucket');
    expect(repoLabel('https://git.example.org/a/b')?.provider).toBe('generic');
  });
  it('is null for nothing, and tolerates a local path', () => {
    expect(repoLabel('')).toBeNull();
    expect(repoLabel(null)).toBeNull();
    expect(repoLabel('/srv/git/app.git')).toEqual({ host: '', short: 'git/app.git', provider: 'generic' });
  });
  it('makes one line', () => {
    expect(repoLine('https://github.com/org/app.git')).toBe('github.com · org/app');
    expect(repoLine(undefined)).toBe('');
  });
  it('knows where tokens and deploy keys live', () => {
    expect(providerTokenPage('github')?.href).toContain('github.com');
    expect(providerTokenPage('generic')).toBeNull();
    expect(deployKeyPlace('github')).toContain('Deploy keys');
  });
});

describe('connection test rendering', () => {
  it('marks and tones steps', () => {
    expect(stepMark({ ok: true })).toBe('✓');
    expect(stepMark({ ok: false })).toBe('✕');
    expect(stepMark({ ok: null })).toBe('–');
    expect(stepTone({ ok: null })).toBe('skip');
  });
  it('formats durations', () => {
    expect(formatDuration(420)).toBe('420 ms');
    expect(formatDuration(2345)).toBe('2.3 s');
    expect(formatDuration(15_000)).toBe('15 s');
  });
  it('summarises ok and failed runs', () => {
    const ok = { ok: true, provider: 'github' as const, durationMs: 1800, defaultBranch: 'main', steps: [{ id: 'url' as const, label: 'Address', ok: true, detail: '' }, { id: 'write' as const, label: 'Write', ok: null, detail: '' }] };
    expect(testSummary(ok)).toBe('Connection works (1 of 2 checks passed) · default branch main · 1.8 s');
    const bad = { ...ok, ok: false, steps: [{ id: 'auth' as const, label: 'Sign-in', ok: false, detail: 'denied' }] };
    expect(testSummary(bad)).toContain('failed at “Sign-in”');
  });
});

describe('time and project choice', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  it('says how long ago', () => {
    expect(relativeTime('2026-10-19T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-10-19T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-10-19T07:00:00Z', now)).toBe('5 h ago');
    expect(relativeTime('2026-10-14T12:00:00Z', now)).toBe('5 d ago');
    expect(relativeTime(null, now)).toBe('');
  });
  const mk = (slug: string, over: Partial<Project> = {}) => ({ slug, name: slug, isDefault: slug === 'default', archivedAt: null, ...over }) as Project;
  it('offers non-archived projects, default first; remembers a still-valid choice', () => {
    const list = [mk('zeta'), mk('alpha', { archivedAt: 'x' }), mk('default'), mk('beta')];
    expect(selectableProjects(list).map((p) => p.slug)).toEqual(['default', 'beta', 'zeta']);
    expect(pickProject(list, 'beta')).toBe('beta');
    expect(pickProject(list, 'alpha')).toBe('default');
    expect(pickProject(list, null)).toBe('default');
    expect(pickProject([], 'x')).toBe('');
  });
});

describe('apiMessage', () => {
  it('unwraps a Nest error body and keeps plain text', async () => {
    const { apiMessage } = await import('./projects');
    const { ApiError } = await import('./http');
    expect(apiMessage(new ApiError(409, '{"message":"has 2 active tasks","statusCode":409}', 'Conflict'))).toBe('has 2 active tasks');
    expect(apiMessage(new ApiError(400, '{"message":["a","b"]}'))).toBe('a; b');
    expect(apiMessage(new ApiError(500, 'boom'))).toBe('boom');
    expect(apiMessage(new Error('x'))).toBe('x');
  });
});
