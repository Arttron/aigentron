import { describe, expect, it } from 'vitest';
import { chownPlan, isolationFor, parseAgentRunAs } from './agent-user';

describe('parseAgentRunAs', () => {
  it('is off when AGENT_RUN_AS_UID is unset or empty (today’s behaviour)', () => {
    expect(parseAgentRunAs({})).toBeNull();
    expect(parseAgentRunAs({ AGENT_RUN_AS_UID: '  ' })).toBeNull();
    expect(parseAgentRunAs({ AGENT_RUN_AS_GID: '1500' })).toBeNull();
  });
  it('reads uid and gid, gid defaulting to uid', () => {
    expect(parseAgentRunAs({ AGENT_RUN_AS_UID: '1500' })).toEqual({ uid: 1500, gid: 1500 });
    expect(parseAgentRunAs({ AGENT_RUN_AS_UID: '1500', AGENT_RUN_AS_GID: '1600' })).toEqual({ uid: 1500, gid: 1600 });
  });
  it('fails closed on garbage and on root', () => {
    expect(() => parseAgentRunAs({ AGENT_RUN_AS_UID: 'agent' })).toThrow(/positive integer/);
    expect(() => parseAgentRunAs({ AGENT_RUN_AS_UID: '0' })).toThrow(/never run as root/);
    expect(() => parseAgentRunAs({ AGENT_RUN_AS_UID: '1500', AGENT_RUN_AS_GID: '0' })).toThrow(/never run as root/);
  });
});

const base = { runDir: '/data/agent/runs/t1', repoPath: '/data/repo', workspaceDir: '/data/workspace', attachmentsDir: '/data/agent/attachments/t1' };

describe('chownPlan', () => {
  it('keeps the run dir root-owned but hands the agent its home, tmp, workspace and attachments', () => {
    const plan = chownPlan({ ...base, worktreePath: null, shared: true });
    expect(plan.find((s) => s.path === '/data/agent/runs/t1')).toMatchObject({ chown: false, mkdir: true, mode: 0o755 });
    expect(plan.find((s) => s.path === '/data/agent/runs/t1/home')).toMatchObject({ recursive: true, mkdir: true, mode: 0o700 });
    expect(plan.find((s) => s.path === '/data/agent/runs/t1/home/tmp')).toMatchObject({ mkdir: true });
    expect(plan.find((s) => s.path === '/data/agent/runs/t1/codex-home')).toMatchObject({ recursive: true, optional: true });
    expect(plan.find((s) => s.path === '/data/workspace')).toMatchObject({ recursive: true, mkdir: true });
    expect(plan.find((s) => s.path === '/data/agent/attachments/t1')).toMatchObject({ recursive: true, mkdir: true });
    // a chat agent / discussion turn: no checkout to own
    expect(plan.some((s) => s.path.startsWith('/data/repo'))).toBe(false);
  });
  it('shared mode: the whole repo', () => {
    const plan = chownPlan({ ...base, worktreePath: '/data/repo', shared: true });
    expect(plan.filter((s) => s.path.startsWith('/data/repo'))).toEqual([{ path: '/data/repo', recursive: true }]);
  });
  it('worktree mode: the worktree plus the main repo’s .git (where the worktree’s index/refs live)', () => {
    const plan = chownPlan({ ...base, worktreePath: '/data/worktrees/t1', shared: false });
    expect(plan.filter((s) => s.path.startsWith('/data/'))).toEqual(
      expect.arrayContaining([
        { path: '/data/repo/.git', recursive: true, optional: true },
        { path: '/data/worktrees/t1', recursive: true },
      ]),
    );
    expect(plan.some((s) => s.path === '/data/repo')).toBe(false);
  });
});

describe('chownPlan — project isolation', () => {
  const base = { runDir: '/d/runs/t1', worktreePath: '/d/worktrees/shop/t1', repoPath: '/d/projects/shop/repo', shared: false, workspaceDir: '/d/projects/shop', attachmentsDir: '/d/attachments/t1' };
  const byPath = (steps: ReturnType<typeof chownPlan>, path: string) => steps.filter((s) => s.path === path);
  it('without the option nothing changes: the same modes as before', () => {
    const plain = chownPlan(base);
    expect(plain.find((s) => s.path === '/d/runs/t1')).toMatchObject({ mode: 0o755, chown: false });
    expect(plain.find((s) => s.path === '/d/projects/shop')).toMatchObject({ mode: 0o755 });
    expect(plain.find((s) => s.path === '/d/attachments/t1')).toMatchObject({ mode: 0o755 });
    expect(plain.some((s) => s.path === '/d/worktrees/shop')).toBe(false);
  });
  it('isolated, worktree mode: the project folder, attachments, main checkout and the worktrees folder are 0700', () => {
    const steps = chownPlan({ ...base, isolated: true });
    expect(steps.find((s) => s.path === '/d/runs/t1')).toMatchObject({ mode: 0o711, chown: false }); // traversable, not listable
    expect(byPath(steps, '/d/projects/shop')[0]).toMatchObject({ mode: 0o700, recursive: true });
    expect(byPath(steps, '/d/attachments/t1')[0]).toMatchObject({ mode: 0o700 });
    expect(byPath(steps, '/d/projects/shop/repo')).toEqual([{ path: '/d/projects/shop/repo', recursive: false, mode: 0o700 }]); // top folder only: its files stay root's
    expect(byPath(steps, '/d/worktrees/shop')[0]).toMatchObject({ mode: 0o700, recursive: false, optional: true });
    expect(byPath(steps, '/d/worktrees/shop/t1')[0]).toMatchObject({ recursive: true });
    expect(byPath(steps, '/d/projects/shop/repo/.git')[0]).toMatchObject({ recursive: true });
  });
  it('isolated, shared mode: the whole checkout is the project user\'s and private', () => {
    const steps = chownPlan({ ...base, worktreePath: base.repoPath, shared: true, isolated: true });
    expect(byPath(steps, base.repoPath)).toEqual([{ path: base.repoPath, recursive: true }, { path: base.repoPath, recursive: false, mode: 0o700 }]);
  });
  it('a chat agent has no checkout: only its own folders', () => {
    const steps = chownPlan({ ...base, worktreePath: null, isolated: true });
    expect(steps.some((s) => s.path.startsWith('/d/worktrees') || s.path.startsWith('/d/projects/shop/repo'))).toBe(false);
  });
});

describe('isolationFor', () => {
  it('builds the runner params with HOME under the run dir', () => {
    expect(isolationFor({ uid: 1500, gid: 1500 }, '/app/infra/agent-exec.sh', '/data/agent/runs/t1')).toEqual({
      uid: 1500,
      gid: 1500,
      wrapper: '/app/infra/agent-exec.sh',
      home: '/data/agent/runs/t1/home',
    });
  });
});
