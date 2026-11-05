import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotACheckoutError, restoreWorktree } from './restore-core';

/** Real git in a temporary repository: clear a task's checkout, then bring it back. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'restore-'));
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'config', 'user.email', 't@t');
  run(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  run(dir, 'add', '.');
  run(dir, 'commit', '-qm', 'first');
  const deps = { git: async (args: string[]) => run(dir, ...args), exists: async (p: string) => existsSync(p) };
  return { dir, run, deps };
}

describe('restoreWorktree', () => {
  it('a checkout that is there is left alone', async () => {
    const { dir, run, deps } = repo();
    const wt = join(dir, '..', `wt-${Math.random().toString(36).slice(2)}`);
    run(dir, 'worktree', 'add', '-b', 'agent/task-x', wt);
    expect(await restoreWorktree(deps, wt, 'agent/task-x')).toBe('present');
    rmSync(wt, { recursive: true, force: true });
  });

  it('a cleared checkout comes back from its branch, with the work that was committed', async () => {
    const { dir, run, deps } = repo();
    const wt = join(dir, '..', `wt-${Math.random().toString(36).slice(2)}`);
    run(dir, 'worktree', 'add', '-b', 'agent/task-y', wt);
    writeFileSync(join(wt, 'work.txt'), 'the work\n');
    run(wt, 'add', '.');
    run(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'work');
    run(dir, 'worktree', 'remove', '--force', wt); // what the cleanup does
    expect(existsSync(wt)).toBe(false);
    expect(await restoreWorktree(deps, wt, 'agent/task-y')).toBe('restored');
    expect(existsSync(join(wt, 'work.txt'))).toBe(true);
    run(dir, 'worktree', 'remove', '--force', wt);
  });

  it('a folder that vanished without git knowing (the registration is stale) is restored too', async () => {
    const { dir, run, deps } = repo();
    const wt = join(dir, '..', `wt-${Math.random().toString(36).slice(2)}`);
    run(dir, 'worktree', 'add', '-b', 'agent/task-z', wt);
    rmSync(wt, { recursive: true, force: true }); // deleted by hand: `git worktree list` still names it
    expect(await restoreWorktree(deps, wt, 'agent/task-z')).toBe('restored');
    expect(existsSync(wt)).toBe(true);
    run(dir, 'worktree', 'remove', '--force', wt);
  });

  it('a branch that was deleted (merged work) is reported, so the caller makes a new checkout', async () => {
    const { dir, deps } = repo();
    expect(await restoreWorktree(deps, join(dir, '..', 'nowhere'), 'agent/task-gone')).toBe('branch-missing');
  });

  it('a folder that exists but is not a checkout (a leftover) is refused with a clear message, not used', async () => {
    const { dir, deps } = repo();
    const leftover = mkdtempSync(join(tmpdir(), 'leftover-'));
    await expect(restoreWorktree({ ...deps, isCheckout: async () => false }, leftover, 'agent/task-q')).rejects.toBeInstanceOf(NotACheckoutError);
    expect(await restoreWorktree({ ...deps, isCheckout: async () => true }, leftover, 'agent/task-q')).toBe('present');
    expect(existsSync(dir)).toBe(true);
  });

  it('a branch that is checked out in another folder cannot be restored: the message says so', async () => {
    const { dir, run, deps } = repo();
    const other = join(dir, '..', `wt-${Math.random().toString(36).slice(2)}`);
    run(dir, 'worktree', 'add', '-b', 'agent/task-busy', other); // the branch is in use here
    await expect(restoreWorktree(deps, join(dir, '..', 'wanted'), 'agent/task-busy')).rejects.toThrow(/in use elsewhere/);
    run(dir, 'worktree', 'remove', '--force', other);
  });
});

