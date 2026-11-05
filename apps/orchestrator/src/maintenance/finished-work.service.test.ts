import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FinishedWorkService } from './finished-work.service';

/** The sweep against real git: what is merged goes, what holds unsaved work stays. */
const DAY = 86_400_000;
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function world(opts: { mode?: 'off' | 'merged' | 'merged_or_done'; doneDays?: number; pr?: (head: string) => { merged: boolean; headSha: string | null } | null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fw-'));
  const repo = join(base, 'repo');
  sh(base, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'first');
  const tasks: Record<string, { id: string; title: string; status: string; updatedAt: Date; branch: string; prUrl: string | null; awaitingSubtasks: boolean; projectId: string }> = {};
  const wts: { path: string; id: string; repo: string; stale: boolean; orphan: boolean }[] = [];
  /** a task with its own checkout; `commit` = a commit on its branch; `dirty` = an untracked file left in the folder */
  const task = (id: string, o: { status?: string; commit?: boolean; dirty?: boolean; finishedDaysAgo?: number; prUrl?: string } = {}) => {
    const path = join(base, 'wt', id);
    const branch = `agent/task-${id}`;
    sh(repo, 'worktree', 'add', '-q', '-b', branch, path);
    if (o.commit) {
      writeFileSync(join(path, `${id}.txt`), 'work\n');
      sh(path, 'add', '.');
      sh(path, 'commit', '-qm', `work of ${id}`);
    }
    if (o.dirty) writeFileSync(join(path, 'unsaved.txt'), 'not committed\n');
    tasks[id] = { id, title: `Task ${id}`, status: o.status ?? 'done', updatedAt: new Date(Date.now() - (o.finishedDaysAgo ?? 10) * DAY), branch, prUrl: o.prUrl ?? null, awaitingSubtasks: false, projectId: 'p1' };
    wts.push({ path, id, repo, stale: false, orphan: false });
    return { path, branch };
  };
  const stopped: string[] = [];
  const svc = new FinishedWorkService(
    { agentDir: join(base, 'agent') } as never,
    { task: { findMany: async () => Object.values(tasks), findUnique: async ({ where }: { where: { id: string } }) => tasks[where.id] ?? null }, agentSession: { groupBy: async () => [] }, project: { findMany: async () => [{ id: 'p1', repoBranch: 'main' }] } } as never,
    { cleanupPolicy: async () => ({ mode: opts.mode ?? 'merged_or_done', doneDays: opts.doneDays ?? 3 }) } as never,
    { listWorktrees: async () => wts.filter((w) => existsSync(w.path)), bytesOf: async () => 1000, gitIn: async (cwd: string, args: string[]) => sh(cwd, ...args) } as never,
    { contextFor: async () => ({}) } as never,
    { get: () => ({ stop: (id: string) => void stopped.push(id), isPrMerged: async () => (opts.pr ? opts.pr(sh(repo, 'rev-parse', 'HEAD')) : null), withTaskLock: (_id: string, f: () => Promise<unknown>) => f() }) } as never,
  );
  const branches = () => sh(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
  return { svc, task, repo, branches, stopped };
}

describe('FinishedWorkService against real git', () => {
  it('work that is already in the base branch: the checkout and the branch go', async () => {
    const w = world();
    const t = w.task('merged', { commit: true, status: 'review', finishedDaysAgo: 0 });
    sh(w.repo, 'merge', '-q', '--no-ff', '-m', 'merge', t.branch); // the work reaches main
    const r = await w.svc.sweep();
    expect(r.removed).toBe(1);
    expect(existsSync(t.path)).toBe(false);
    expect(w.branches()).not.toContain(t.branch);
    expect(r.entries[0]).toMatchObject({ taskId: 'merged', branchDeleted: true, reason: expect.stringContaining('base branch') });
    expect(w.stopped).toEqual(['merged']);
  });

  it('a task that did nothing (its branch has no commits of its own) and is done: cleared', async () => {
    const w = world();
    const t = w.task('empty', { status: 'done' });
    expect((await w.svc.sweep()).removed).toBe(1);
    expect(existsSync(t.path)).toBe(false);
  });

  it('commits that exist nowhere else are never lost: not merged, not pushed → kept, branch included', async () => {
    const w = world();
    const t = w.task('precious', { commit: true, status: 'done', finishedDaysAgo: 30 });
    const r = await w.svc.sweep();
    expect(r.removed).toBe(0);
    expect(existsSync(t.path)).toBe(true);
    const plan = await w.svc.plan();
    expect(plan.items[0]!.decision.reason).toContain('exist only here');
  });

  it('uncommitted files keep the checkout, even when the work is merged', async () => {
    const w = world();
    const t = w.task('dirty', { commit: true, dirty: true });
    sh(w.repo, 'merge', '-q', '--no-ff', '-m', 'merge', t.branch);
    expect((await w.svc.sweep()).removed).toBe(0);
    expect(existsSync(join(t.path, 'unsaved.txt'))).toBe(true);
  });

  it('a task that is still running is never touched', async () => {
    const w = world();
    const t = w.task('live', { status: 'running' });
    expect((await w.svc.sweep()).removed).toBe(0);
    expect(existsSync(t.path)).toBe(true);
  });

  it('a finished task whose commits are on the remote is cleared after the grace period; its branch stays', async () => {
    const w = world();
    const remote = mkdtempSync(join(tmpdir(), 'fw-remote-'));
    sh(remote, 'init', '-q', '--bare', '-b', 'main');
    sh(w.repo, 'remote', 'add', 'origin', remote);
    sh(w.repo, 'push', '-q', 'origin', 'main');
    const recent = w.task('recent', { commit: true, finishedDaysAgo: 1 });
    const old = w.task('old', { commit: true, finishedDaysAgo: 5 });
    sh(w.repo, 'push', '-q', 'origin', recent.branch, old.branch);
    const r = await w.svc.sweep();
    expect(r.entries.map((e) => e.taskId)).toEqual(['old']);
    expect(existsSync(old.path)).toBe(false);
    expect(w.branches()).toContain(old.branch); // its commits are not in main: the branch is kept
    expect(existsSync(recent.path)).toBe(true); // finished one day ago: waits
  });

  it('the mode "merged" leaves finished-but-unmerged work alone; "off" does nothing at all', async () => {
    const a = world({ mode: 'merged' });
    const t = a.task('x', { status: 'done', finishedDaysAgo: 30 });
    expect((await a.svc.sweep()).removed).toBe(1); // nothing of its own: "merged" by definition
    expect(existsSync(t.path)).toBe(false);
    const b = world({ mode: 'off' });
    const u = b.task('y', { status: 'done', finishedDaysAgo: 30 });
    expect((await b.svc.sweep()).removed).toBe(0);
    expect(existsSync(u.path)).toBe(true);
  });

  it('plan() touches nothing and says what would happen and why; the log remembers what was cleared', async () => {
    const w = world();
    const t = w.task('p', { status: 'done' });
    const plan = await w.svc.plan();
    expect(plan).toMatchObject({ willRemove: 1, willFree: 1000, items: [{ taskId: 'p', decision: { remove: true } }] });
    expect(existsSync(t.path)).toBe(true);
    await w.svc.sweep();
    expect((await w.svc.log())[0]).toMatchObject({ taskId: 'p', bytes: 1000 });
  });
});

describe('FinishedWorkService: what the review found', () => {
  it('a DETACHED HEAD with commits is not "merged" just because the task branch still points at main', async () => {
    const w = world();
    const t = w.task('detached', { status: 'done', finishedDaysAgo: 30 });
    writeFileSync(join(t.path, 'secret-work.txt'), 'only here\n');
    sh(t.path, 'add', '.');
    sh(t.path, 'checkout', '-q', '--detach');
    sh(t.path, 'commit', '-qm', 'work on a detached head');
    expect(sh(w.repo, 'rev-list', '--count', 'main..' + t.branch).trim()).toBe('0'); // the branch says "nothing" ...
    const r = await w.svc.sweep();
    expect(r.removed).toBe(0); // ... the folder says otherwise
    expect(existsSync(join(t.path, 'secret-work.txt'))).toBe(true);
  });

  it('a folder moved to ANOTHER branch with commits keeps its checkout too', async () => {
    const w = world();
    const t = w.task('elsewhere', { status: 'done', finishedDaysAgo: 30 });
    sh(t.path, 'checkout', '-q', '-b', 'scratch');
    writeFileSync(join(t.path, 'x.txt'), 'x\n');
    sh(t.path, 'add', '.');
    sh(t.path, 'commit', '-qm', 'on scratch');
    expect((await w.svc.sweep()).removed).toBe(0);
    expect(existsSync(t.path)).toBe(true);
  });

  it('build output that git ignores (node_modules, dist) is not unsaved work: the merged checkout still goes', async () => {
    const w = world();
    const t = w.task('buildonly', { status: 'done' });
    writeFileSync(join(t.path, '.gitignore'), 'node_modules/\ndist/\n');
    sh(t.path, 'add', '.gitignore');
    sh(t.path, 'commit', '-qm', 'ignore');
    sh(w.repo, 'merge', '-q', '--no-ff', '-m', 'merge', t.branch);
    mkdirSync(join(t.path, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(t.path, 'node_modules', 'x', 'i.js'), '1');
    mkdirSync(join(t.path, 'dist'));
    writeFileSync(join(t.path, 'dist', 'o.js'), '1');
    expect((await w.svc.sweep()).removed).toBe(1);
    expect(existsSync(t.path)).toBe(false);
  });

  it('an ignored .env alone (everything else merged) keeps the checkout', async () => {
    const w = world();
    const t = w.task('onlyenv', { status: 'done' });
    writeFileSync(join(t.path, '.gitignore'), '.env\n');
    sh(t.path, 'add', '.gitignore');
    sh(t.path, 'commit', '-qm', 'ignore');
    sh(w.repo, 'merge', '-q', '--no-ff', '-m', 'merge', t.branch);
    writeFileSync(join(t.path, '.env'), 'SECRET=1\n');
    const r = await w.svc.sweep();
    expect(r.removed).toBe(0);
    expect(existsSync(join(t.path, '.env'))).toBe(true);
    expect((await w.svc.plan()).items[0]!.decision.reason).toContain('.env');
  });

  it('a pull request that was merged long ago does not make NEWER unpushed commits merged', async () => {
    let prTip = '';
    const w = world({ pr: () => ({ merged: true, headSha: prTip }) });
    const t = w.task('stalepr', { commit: true, status: 'failed', finishedDaysAgo: 30, prUrl: 'https://github.com/o/r/pull/1' });
    prTip = sh(t.path, 'rev-parse', 'HEAD').trim(); // the tip the pull request had when it was merged
    writeFileSync(join(t.path, 'newer.txt'), 'newer\n');
    sh(t.path, 'add', '.');
    sh(t.path, 'commit', '-qm', 'after the pull request was merged'); // a follow-up: exists only here
    const r = await w.svc.sweep();
    expect(r.removed).toBe(0);
    expect(existsSync(join(t.path, 'newer.txt'))).toBe(true);
    expect(w.branches()).toContain(t.branch);
  });

  it('a merged pull request whose tip IS the branch tip (a squash merge: the history does not show it) clears the checkout and the branch', async () => {
    let prTip = '';
    const w = world({ pr: () => ({ merged: true, headSha: prTip }) });
    const t = w.task('squashed', { commit: true, status: 'review', finishedDaysAgo: 0, prUrl: 'https://github.com/o/r/pull/2' });
    prTip = sh(t.path, 'rev-parse', 'HEAD').trim();
    const r = await w.svc.sweep();
    expect(r.removed).toBe(1);
    expect(r.entries[0]).toMatchObject({ branchDeleted: true, reason: expect.stringContaining('pull request') });
    expect(existsSync(t.path)).toBe(false);
  });

  it('a pull request that was closed without merging changes nothing', async () => {
    const w = world({ pr: () => ({ merged: false, headSha: 'a'.repeat(40) }) });
    const t = w.task('closedpr', { commit: true, status: 'review', prUrl: 'https://github.com/o/r/pull/3' });
    expect((await w.svc.sweep()).removed).toBe(0);
    expect(existsSync(t.path)).toBe(true);
  });
});
