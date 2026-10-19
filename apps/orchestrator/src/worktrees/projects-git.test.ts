import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import type { GitCredentialsProvider, ProjectGitRef } from '../projects/git-credentials.port';
import { RepoSyncService } from '../projects/git/repo-sync.service';
import { buildProjectContext, type ProjectContext } from '../projects/project-context';
import type { ProjectRow } from '../projects/projects.service';
import { anonymousAuth, tokenAuth } from './git-auth';
import { GitHubService } from './github.service';
import { WorktreeService } from './worktree.service';

const exec = promisify(execFile);
const IDENT = ['-c', 'user.email=t@test', '-c', 'user.name=Test'];
const git = async (cwd: string, ...args: string[]) => (await exec('git', [...IDENT, ...args], { cwd })).stdout.trim();

/**
 * Two projects, two local bare repositories as their remotes, real git and no network: each project's checkout is
 * cloned / fetched into its own path (RepoSyncService, per-project lock), worktrees nest per project, a push goes to
 * the right remote, and no credential ever lands in a checkout's `.git/config`.
 */
let base: string;
let remotes: { a: string; b: string };
let asked: ProjectGitRef[];
let rows: Map<string, ProjectRow>;
let worktrees: WorktreeService;
let github: GitHubService;
let repoSync: RepoSyncService;

/** A bare repo with one commit on `main`, as a `file://` URL. */
async function bareRemote(name: string): Promise<string> {
  const src = join(base, `${name}-src`);
  await mkdir(src);
  await git(src, 'init', '-q', '-b', 'main');
  await writeFile(join(src, 'README.md'), `# ${name}\n`);
  await git(src, 'add', '.');
  await git(src, 'commit', '-q', '-m', 'init');
  const bare = join(base, `${name}.git`);
  await git(base, 'clone', '-q', '--bare', src, bare);
  return `file://${bare}`;
}

const paths = () => ({ workspaceRepoPath: join(base, 'repo'), workspaceDir: join(base, 'workspace'), projectsDir: join(base, 'projects'), workspaceShared: false });

/** A project row (what the database holds) and its runtime context (what the worker hands around). */
function project(slug: string, repoUrl: string | null, over: Partial<ProjectRow> = {}): ProjectContext {
  const row = {
    id: `p_${slug}`,
    slug,
    name: slug,
    kind: 'code',
    isDefault: slug === 'default',
    repoUrl,
    repoBranch: 'main',
    repoSubdir: null,
    repoAuth: 'none',
    repoPath: slug === 'default' ? join(base, 'repo') : null,
    isolation: null,
    verifyCommands: null,
    verifyMaxAttempts: 2,
    defaultAgent: null,
    notifyChannelId: null,
    notifyChatId: null,
    archivedAt: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ProjectRow;
  rows.set(slug, row);
  return buildProjectContext(row, paths());
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lds-git-')));
  remotes = { a: await bareRemote('a'), b: await bareRemote('b') };
  asked = [];
  rows = new Map();
  const config = { agentRunAs: null, worktreesRoot: join(base, 'worktrees'), workspaceRepoPath: join(base, 'repo') } as AppConfigService;
  const credentials: GitCredentialsProvider = {
    authFor: async (p) => {
      asked.push(p);
      return p.repoAuth === 'token' ? tokenAuth('ghp_test') : anonymousAuth();
    },
    apiTokenFor: async (p) => (p.repoAuth === 'token' ? 'ghp_test' : null),
  };
  const projects = {
    get: async (slug: string) => {
      const r = rows.get(slug);
      if (!r) throw new Error(`Project "${slug}" not found`);
      return r;
    },
    repoPathOf: (r: ProjectRow) => buildProjectContext(r, paths()).repoPath,
  };
  repoSync = new RepoSyncService(config, projects as never, credentials as never);
  worktrees = new WorktreeService(config, repoSync, projects as never, credentials);
  github = new GitHubService(credentials, { githubToken: async () => null } as never);
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('per-project git', () => {
  it('clones each project into its own checkout, fetches on the next ensure, asks the port per project, persists nothing', async () => {
    const a = project('alpha', remotes.a);
    const b = project('beta', remotes.b, { repoAuth: 'token' });
    const [ra, rb] = await Promise.all([repoSync.ensure(rows.get('alpha')!), repoSync.ensure(rows.get('beta')!)]);
    expect([ra.action, rb.action]).toEqual(['cloned', 'cloned']);
    expect(a.repoPath).toBe(join(base, 'projects', 'alpha', 'repo'));
    expect(await readFile(join(a.repoPath, 'README.md'), 'utf8')).toBe('# a\n');
    expect(await readFile(join(b.repoPath, 'README.md'), 'utf8')).toBe('# b\n');
    expect(asked.map((p) => [p.slug, p.repoAuth])).toEqual(expect.arrayContaining([['alpha', 'none'], ['beta', 'token']]));
    // the token auth travels per command only: nothing in either checkout's config
    for (const repo of [a.repoPath, b.repoPath]) await expect(git(repo, 'config', '--get-all', 'http.extraHeader')).rejects.toThrow();
    // the remote moves on → the next ensure fetches it
    const src = join(base, 'a-src');
    await writeFile(join(src, 'more.txt'), 'x');
    await git(src, 'add', '.');
    await git(src, 'commit', '-q', '-m', 'more');
    await git(src, 'push', '-q', remotes.a.replace('file://', ''), 'main');
    expect((await repoSync.ensure(rows.get('alpha')!)).action).toBe('fetched');
    expect(await git(a.repoPath, 'rev-parse', 'origin/main')).toBe(await git(src, 'rev-parse', 'main'));
    expect(await repoSync.baseRef(rows.get('alpha')!)).toBe('origin/main');
  });

  it('a project without a URL gets a local repo with a HEAD; the default project adopts WORKSPACE_REPO_PATH', async () => {
    const d = project('default', null);
    await repoSync.ensure(rows.get('default')!);
    expect(d.repoPath).toBe(join(base, 'repo'));
    expect(await git(d.repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(await repoSync.baseRef(rows.get('default')!)).toBe('HEAD');
    expect(asked).toEqual([]); // no URL → the port is never asked
  });

  it('worktrees nest per project (WORKTREES_ROOT/<slug>/<taskId>) and are cleaned up from the right checkout', async () => {
    const a = project('alpha', remotes.a);
    const b = project('beta', remotes.b);
    const [wa, wb] = await Promise.all([worktrees.createForTask(a, 't1'), worktrees.createForTask(b, 't1')]);
    expect(wa).toEqual({ branch: 'agent/task-t1', worktreePath: join(base, 'worktrees', 'alpha', 't1') });
    expect(wb).toEqual({ branch: 'agent/task-t1', worktreePath: join(base, 'worktrees', 'beta', 't1') });
    expect(await readFile(join(wa.worktreePath, 'README.md'), 'utf8')).toBe('# a\n');
    expect(await readFile(join(wb.worktreePath, 'README.md'), 'utf8')).toBe('# b\n');
    expect(worktrees.isTaskWorktree(wa.worktreePath)).toBe(true);
    expect(worktrees.isTaskWorktree(a.repoPath)).toBe(false);
    // cleanup of one task's worktree + branch, in ITS project's checkout; the other project's is untouched
    await worktrees.cleanup(wa.branch, wa.worktreePath);
    expect(existsSync(wa.worktreePath)).toBe(false);
    expect(await git(a.repoPath, 'branch', '--list', 'agent/task-t1')).toBe('');
    expect(existsSync(wb.worktreePath)).toBe(true);
    expect(await git(b.repoPath, 'branch', '--list', 'agent/task-t1')).toContain('agent/task-t1');
    // a project checkout is never "cleaned up"
    await worktrees.cleanup('main', a.repoPath);
    expect(existsSync(a.repoPath)).toBe(true);
  });

  it('shared mode: a push goes to the project\'s own remote and nowhere else', async () => {
    const a = project('alpha', remotes.a);
    const b = project('beta', remotes.b);
    const [sa, sb] = await Promise.all([worktrees.useSharedRepo(a), worktrees.useSharedRepo(b)]);
    expect(sa).toEqual({ branch: 'main', worktreePath: a.repoPath });
    expect(sb.worktreePath).toBe(b.repoPath);
    await writeFile(join(a.repoPath, 'change.txt'), 'by an agent');
    await git(a.repoPath, 'add', '.');
    await git(a.repoPath, 'commit', '-q', '-m', 'agent change');
    const link = await github.pushSharedWorkspace(a, 'main');
    expect(link).toBe(remotes.a);
    const headA = await git(a.repoPath, 'rev-parse', 'HEAD');
    expect(await git(base, '--git-dir', remotes.a.replace('file://', ''), 'rev-parse', 'main')).toBe(headA);
    expect(await git(base, '--git-dir', remotes.b.replace('file://', ''), 'rev-parse', 'main')).not.toBe(headA);
    // https without credentials is skipped (today's behaviour), a local remote is not
    const noToken = project('gamma', 'https://github.com/acme/gamma.git');
    expect(await github.pushSharedWorkspace(noToken, 'main')).toBeNull();
  });

  it('publishResult: a non-GitHub remote is skipped before any push; a project without a URL too', async () => {
    const a = project('alpha', remotes.a);
    await repoSync.ensure(rows.get('alpha')!);
    expect(await github.publishResult(a, { branch: 'agent/task-x', title: 't', body: 'b' })).toBeNull();
    expect(await github.publishResult(project('none', null), { branch: 'x', title: 't', body: 'b' })).toBeNull();
  });

  it('ensure() of one project is serialised; the other project is not waiting behind it', async () => {
    project('alpha', remotes.a);
    const b = project('beta', remotes.b);
    const order: string[] = [];
    const slow = repoSync.ensure(rows.get('alpha')!).then(() => order.push('a1'));
    const again = repoSync.ensure(rows.get('alpha')!).then(() => order.push('a2'));
    const other = repoSync.ensure(rows.get('beta')!).then(() => order.push('b'));
    await Promise.all([slow, again, other]);
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2'));
    expect(existsSync(join(b.repoPath, 'README.md'))).toBe(true);
  });

  it('a token auth env is accepted by git on a file:// clone (the header is simply unused)', async () => {
    const a = project('alpha', remotes.a, { repoAuth: 'token' });
    await repoSync.ensure(rows.get('alpha')!);
    expect(existsSync(join(a.repoPath, 'README.md'))).toBe(true);
    expect(asked.map((p) => p.repoAuth)).toEqual(['token']);
  });
});
