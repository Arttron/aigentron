import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../../config/app-config.service';
import type { ProjectsService, ProjectRow } from '../projects.service';
import type { GitAccessService } from './git-access.service';
import { ANONYMOUS_AUTH } from './git-runner';
import { RepoSyncService } from './repo-sync.service';

let base: string;
let calls: string[];
let svc: RepoSyncService;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function makeRemote(name: string): { bare: string; work: string } {
  const bare = join(base, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const work = join(base, `${name}-seed`);
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' });
  writeFileSync(join(work, 'README.md'), 'one\n');
  git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'one');
  git(work, 'push', '-q', 'origin', 'main');
  return { bare, work };
}

function row(slug: string, patch: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: `id_${slug}`, slug, name: slug, kind: 'code', isDefault: false, repoUrl: null, repoBranch: 'main', repoSubdir: null, repoAuth: 'none', repoPath: null, isolation: null,
    verifyCommands: null, verifyMaxAttempts: 2, defaultAgent: null, notifyChannelId: null, notifyChatId: null, archivedAt: null, createdById: null, createdAt: new Date(), updatedAt: new Date(), ...patch,
  } as ProjectRow;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lds-reposync-'));
  calls = [];
  const projects = { get: async (slug: string) => row(slug), repoPathOf: (p: ProjectRow) => p.repoPath ?? join(base, 'projects', p.slug, 'repo') } as unknown as ProjectsService;
  const access = {
    authFor: async (p: ProjectRow) => {
      calls.push(`authFor:${p.slug}`);
      return ANONYMOUS_AUTH;
    },
  } as unknown as GitAccessService;
  svc = new RepoSyncService({ agentRunAs: null } as AppConfigService, projects, access);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('RepoSyncService', () => {
  it('a failed fetch of an existing checkout: strict (Sync now) throws, lenient (task runs) goes on from the last fetched state', async () => {
    const { bare } = makeRemote('f');
    const p = row('f', { repoUrl: `file://${bare}` });
    await svc.ensure(p); // clone
    const broken = { ...p, repoUrl: `file://${bare}-gone` }; // the remote vanished / the credentials stopped working
    await expect(svc.ensure(broken)).rejects.toThrow();
    const r = await svc.ensure(broken, { lenient: true });
    expect(r.action).toBe('unchanged');
    expect(r.detail).toMatch(/fetch failed/);
    expect(r.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('clones on the first sync, fetches on the next, through the project credentials; .git/config stays credential-free', async () => {
    const { bare, work } = makeRemote('a');
    const p = row('a', { repoUrl: `file://${bare}` });
    const first = await svc.ensure(p);
    expect(first.action).toBe('cloned');
    expect(first.path).toBe(join(base, 'projects', 'a', 'repo'));
    expect(existsSync(join(first.path, 'README.md'))).toBe(true);
    expect(first.head).toMatch(/^[0-9a-f]{40}$/);
    expect(calls).toEqual(['authFor:a']);
    expect(readFileSync(join(first.path, '.git', 'config'), 'utf8')).not.toMatch(/extraHeader|Authorization/i);

    writeFileSync(join(work, 'README.md'), 'two\n');
    git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'two');
    git(work, 'push', '-q', 'origin', 'main');
    const second = await svc.ensure(p);
    expect(second.action).toBe('fetched');
    expect(second.head).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(second.head).not.toBe(first.head);
    expect(await svc.baseRef(p)).toBe('origin/main');
    expect(git(first.path, 'remote', 'get-url', 'origin')).toBe(`file://${bare}`);
  });

  it('repoints origin when the URL changes', async () => {
    const a = makeRemote('a');
    const b = makeRemote('b');
    const p = row('x', { repoUrl: `file://${a.bare}` });
    await svc.ensure(p);
    const moved = await svc.ensure({ ...p, repoUrl: `file://${b.bare}` });
    expect(moved.action).toBe('fetched');
    expect(git(moved.path, 'remote', 'get-url', 'origin')).toBe(`file://${b.bare}`);
  });

  it('initialises a local repository when the project has no URL (with a HEAD), then leaves it alone', async () => {
    const p = row('local');
    const r = await svc.ensure(p);
    expect(r.action).toBe('initialized');
    expect(git(r.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect((await svc.ensure(p)).action).toBe('unchanged');
    expect(await svc.baseRef(p)).toBe('HEAD');
    expect(calls).toEqual([]);
  });

  it('skips docs projects and reports a missing branch as a clear error', async () => {
    expect((await svc.ensure(row('d', { kind: 'docs' }))).action).toBe('skipped');
    const { bare } = makeRemote('m');
    await expect(svc.ensure(row('m', { repoUrl: `file://${bare}`, repoBranch: 'nope' }))).rejects.toThrow(/clone failed.*(Remote branch nope not found|not found)/s);
  });

  it('serialises syncs of the same project (concurrent ensures → one clone, one fetch)', async () => {
    const { bare } = makeRemote('s');
    const p = row('s', { repoUrl: `file://${bare}` });
    const [r1, r2, r3] = await Promise.all([svc.ensure(p), svc.ensure(p), svc.ensure(p)]);
    expect([r1.action, r2.action, r3.action]).toEqual(['cloned', 'fetched', 'fetched']);
  });

  it('accepts a slug (resolved through ProjectsService)', async () => {
    const r = await svc.ensure('byslug');
    expect(r.action).toBe('initialized');
    expect(r.path).toBe(join(base, 'projects', 'byslug', 'repo'));
  });
});
