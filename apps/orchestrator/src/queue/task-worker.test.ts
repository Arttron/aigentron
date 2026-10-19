import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRunOutcome } from '../agent/agent-executor';
import { KeyedMutex } from '../projects/project-mutex';
import type { ProjectContext } from '../projects/project-context';
import { TaskWorkerService } from './task-worker.service';

interface Opts {
  /** what the guarded `→ running` transition answers */
  entry?: 'started' | 'busy' | 'gone';
  status?: string;
  chat?: boolean;
  parentId?: string | null;
  requireStatusReport?: boolean;
  /** continuation prompts this task already had (vs maxContinuations = 1) */
  priorContinuations?: number;
  verify?: { ran: boolean; ok: boolean; output: string };
  outcome?: Partial<AgentRunOutcome>;
  /** the task row disappears (deleted) while the run is going */
  vanish?: boolean;
  runThrows?: Error;
}

const project = (over: Partial<ProjectContext> = {}): ProjectContext => ({
  id: 'proj_default',
  slug: 'default',
  name: 'Default',
  kind: 'code',
  isDefault: true,
  repoPath: '/wt',
  repoUrl: null,
  repoBranch: 'main',
  repoSubdir: '',
  repoAuth: 'none',
  isolation: 'worktree',
  verifyCommands: ['true'],
  verifyMaxAttempts: 0,
  workspaceRoot: '/ws',
  briefFile: 'WORKSPACE.md',
  briefTemplate: '',
  defaultAgent: null,
  notifyChannelId: null,
  notifyChatId: null,
  git: { slug: 'default', repoUrl: null, repoAuth: 'none' },
  ...over,
});

/** A worker over fakes: records every lifecycle call in order. */
function make(o: Opts = {}) {
  const calls: string[] = [];
  const statusWrites: { status: string; error?: string }[] = [];
  const row = {
    id: 'T',
    status: o.status ?? 'running',
    agentName: 'a',
    parentId: o.parentId ?? null,
    projectId: 'proj_default',
    worktreePath: '/wt',
    branch: 'b',
    title: 't',
    prompt: 'p',
  };
  let gone = false;
  const svc = Object.create(TaskWorkerService.prototype) as TaskWorkerService & Record<string, unknown>;
  Object.assign(svc, {
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    config: { agentDir: '/agent', requireStatusReport: o.requireStatusReport ?? false, maxContinuations: 1 },
    decomposeHandedBack: new Set<string>(),
    projectLocks: new KeyedMutex(),
    waiting: 0,
    lastConcurrency: 2,
    queue: { setConcurrency: () => undefined },
    projects: { contextFor: async () => project() },
    tasks: {
      startRunning: async (id: string) => {
        calls.push(`startRunning:${id}`);
        return o.entry ?? 'started';
      },
      holdFollowUp: async (id: string, text: string) => void calls.push(`holdFollowUp:${text}`),
      setStatus: async (_id: string, status: string, error?: string) => {
        calls.push(`setStatus:${status}`);
        statusWrites.push({ status, error });
        if (gone) return null;
        row.status = status;
        return row;
      },
      get: async () => {
        if (gone) throw new Error('Task T not found');
        return row;
      },
      getLite: async () => {
        if (gone) throw new Error('Task T not found');
        return row;
      },
      attachWorktree: async () => undefined,
      attachPr: async () => undefined,
      scheduleFollowUp: async () => undefined,
      continueRun: async (_id: string, prompt: string) => void calls.push(`continueRun:${prompt.slice(0, 19)}`),
      runSettled: async () => void calls.push('runSettled'),
      fanInAfterSettle: async () => void calls.push('fanIn'),
    },
    agents: { get: async () => ({ mode: o.chat ? 'chat' : 'code' }) },
    executor: {
      run: async () => {
        calls.push('executor.run');
        if (o.vanish) gone = true;
        if (o.runThrows) throw o.runThrows;
        return { reported: null, errored: false, timedOut: false, ...o.outcome };
      },
    },
    preview: { stop: () => void calls.push('preview.stop') },
    verification: { verify: async () => o.verify ?? { ran: false, ok: true, output: '' } },
    github: { publishResult: async () => null, pushSharedWorkspace: async () => null },
    worktrees: { createForTask: async () => ({ worktreePath: '/wt', branch: 'b' }), useSharedRepo: async () => ({ worktreePath: '/wt', branch: 'b' }) },
    approvals: {
      continuationCount: async () => o.priorContinuations ?? 0,
      requestContinuation: async () => void calls.push('requestContinuation'),
    },
  });
  const process = (svc as unknown as { process: (d: { taskId: string; followUpPrompt?: string }) => Promise<void> }).process.bind(svc);
  return { process, calls, statusWrites, row };
}

describe('TaskWorkerService.process — entry guard', () => {
  it('drops the job when the task may not start (cancelled / done / deleted) — no run, no status write', async () => {
    const { process, calls } = make({ entry: 'gone' });
    await process({ taskId: 'T' });
    expect(calls).toEqual(['startRunning:T']);
  });

  it('a follow-up that arrives while another run of the task is live is held, not run alongside it (X-Q-1)', async () => {
    const { process, calls } = make({ entry: 'busy' });
    await process({ taskId: 'T', followUpPrompt: 'later' });
    expect(calls).toEqual(['startRunning:T', 'holdFollowUp:later']);
  });

  it('an initial run that finds the task busy is simply dropped', async () => {
    const { process, calls } = make({ entry: 'busy' });
    await process({ taskId: 'T' });
    expect(calls).toEqual(['startRunning:T']);
  });

  it('runs the task once the guarded transition to running succeeded; pending follow-ups drain only after the run has fully settled (X-Q-3)', async () => {
    const { process, calls } = make({ chat: true, outcome: { reported: 'done' } });
    await process({ taskId: 'T' });
    expect(calls).toEqual(['startRunning:T', 'executor.run', 'setStatus:review', 'preview.stop', 'runSettled', 'fanIn']);
  });
});

/** The table: what a run produced → the status the task ends in (E-33 / E-29). */
describe('TaskWorkerService.process — run outcome → status', () => {
  const cases: { name: string; o: Opts; status: string | null; error?: string | RegExp; extra?: string[] }[] = [
    { name: 'reported done, clean → review (person accepts)', o: { outcome: { reported: 'done' } }, status: 'review' },
    { name: 'reported done, as a subtask → done (the lead accepts)', o: { outcome: { reported: 'done' }, parentId: 'P' }, status: 'done' },
    { name: 'reported done even though the run then errored → still a clean finish', o: { outcome: { reported: 'done', errored: true } }, status: 'review' },
    { name: 'reported blocked → blocked with the summary', o: { outcome: { reported: 'blocked', reportedSummary: 'need creds' } }, status: 'blocked', error: 'need creds' },
    { name: 'reported blocked without a summary → blocked, default reason', o: { outcome: { reported: 'blocked' } }, status: 'blocked', error: 'agent reported blocked' },
    { name: 'reported failed → failed with the summary', o: { outcome: { reported: 'failed', reportedSummary: 'tests red' } }, status: 'failed', error: 'tests red' },
    { name: 'reported failed without a summary → failed, default reason', o: { outcome: { reported: 'failed' } }, status: 'failed', error: 'agent reported failure' },
    { name: 'out of steps, no report, first time → a continuation is requested (no status write)', o: { outcome: { maxTurns: true } }, status: null, extra: ['requestContinuation'] },
    { name: 'out of steps again, top-level → handed back once to decompose', o: { outcome: { maxTurns: true }, priorContinuations: 1 }, status: null, extra: ['continueRun:You have repeatedly'] },
    { name: 'out of steps again, subtask → stalled (no hand-back for subtasks)', o: { outcome: { maxTurns: true }, priorContinuations: 1, parentId: 'P' }, status: 'stalled', error: /hit the step limit 2×/ },
    { name: 'timed out without a report → stalled', o: { outcome: { errored: true, timedOut: true } }, status: 'stalled', error: 'run timed out without a status report' },
    { name: 'crashed without a report, last message kept → stalled with the question', o: { outcome: { errored: true, finalText: 'Which DB?' } }, status: 'stalled', error: "run ended abnormally without a status report — agent's last message:\nWhich DB?" },
    { name: 'clean finish without a report, strict mode → stalled', o: { outcome: {}, requireStatusReport: true }, status: 'stalled', error: 'run finished without calling report_task_status' },
    { name: 'clean finish without a report, strict mode, last message → stalled with it', o: { outcome: { finalText: 'done?' }, requireStatusReport: true }, status: 'stalled', error: "run finished without calling report_task_status — agent's last message:\ndone?" },
    { name: 'clean finish without a report, lenient → review', o: { outcome: {} }, status: 'review' },
    { name: 'verification fails → failed with its output', o: { outcome: { reported: 'done' }, verify: { ran: true, ok: false, output: 'boom' } }, status: 'failed', error: 'verification failed:\nboom' },
    { name: 'the run throws → failed with the message', o: { runThrows: new Error('spawn ENOENT') }, status: 'failed', error: 'spawn ENOENT' },
    { name: 'cancelled mid-run → left alone', o: { outcome: { errored: true }, status: 'cancelled' }, status: null },
    // chat agents: no worktree / verify / publish; a turn settles the same way
    { name: 'chat: reported done → review', o: { chat: true, outcome: { reported: 'done' } }, status: 'review' },
    { name: 'chat: subtask → done', o: { chat: true, outcome: { reported: 'done' }, parentId: 'P' }, status: 'done' },
    { name: 'chat: no report → review', o: { chat: true, outcome: {} }, status: 'review' },
    { name: 'chat: timed out → failed', o: { chat: true, outcome: { errored: true, timedOut: true } }, status: 'failed', error: 'chat turn timed out' },
    { name: 'chat: errored with a last message → failed with it', o: { chat: true, outcome: { errored: true, finalText: 'x'.repeat(600) } }, status: 'failed', error: 'x'.repeat(500) },
    { name: 'chat: errored without a message → failed', o: { chat: true, outcome: { errored: true } }, status: 'failed', error: 'chat turn failed' },
    { name: 'chat: reported blocked (e.g. budget) → blocked', o: { chat: true, outcome: { reported: 'blocked', reportedSummary: 'budget' } }, status: 'blocked', error: 'budget' },
    { name: 'chat: cancelled mid-turn → left alone', o: { chat: true, outcome: {}, status: 'cancelled' }, status: null },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const { process, calls, statusWrites } = make(c.o);
      await process({ taskId: 'T' }).catch(() => undefined);
      const writes = statusWrites.filter((w) => w.status !== 'running');
      if (c.status === null) {
        expect(writes).toEqual([]);
      } else {
        expect(writes.map((w) => w.status)).toEqual([c.status]);
        if (c.error instanceof RegExp) expect(writes[0]!.error).toMatch(c.error);
        else if (c.error !== undefined) expect(writes[0]!.error).toBe(c.error);
      }
      for (const e of c.extra ?? []) expect(calls).toContain(e);
      expect(calls.at(-2)).toBe('runSettled');
      expect(calls.at(-1)).toBe('fanIn');
    });
  }

  it('a task deleted during the run: no status write on the missing row, no error out of the job (E-23)', async () => {
    const { process, calls, statusWrites } = make({ runThrows: new Error('aborted'), vanish: true });
    await expect(process({ taskId: 'T' })).resolves.toBeUndefined();
    expect(statusWrites).toEqual([]);
    expect(calls).toContain('runSettled');
  });
});

/**
 * Projects and the per-project lock (docs/plan-projects-workspace.md §2.6): a worker over fakes where every run is
 * a gate the test opens by hand, so the ORDER of runs is observable.
 */
function makeMulti(projectsById: Record<string, ProjectContext>, tasks: Record<string, { projectId: string; parentId?: string | null; chat?: boolean }>) {
  const log: string[] = [];
  const gates = new Map<string, () => void>();
  const concurrency: number[] = [];
  const checkouts: string[] = [];
  const svc = Object.create(TaskWorkerService.prototype) as TaskWorkerService & Record<string, unknown>;
  Object.assign(svc, {
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    config: { agentDir: '/agent', requireStatusReport: false, maxContinuations: 1 },
    decomposeHandedBack: new Set<string>(),
    projectLocks: new KeyedMutex(),
    waiting: 0,
    lastConcurrency: 2,
    queue: { setConcurrency: (n: number) => void concurrency.push(n) },
    projects: { contextFor: async (t: { projectId: string }) => projectsById[t.projectId]! },
    tasks: {
      startRunning: async () => 'started',
      getLite: async (id: string) => ({ id, status: 'running', agentName: tasks[id]!.chat ? 'admin' : 'a', parentId: tasks[id]!.parentId ?? null, projectId: tasks[id]!.projectId, worktreePath: null, branch: null, title: id, prompt: 'p' }),
      attachWorktree: async (id: string, branch: string, path: string) => void checkouts.push(`${id}:${path}@${branch}`),
      attachPr: async () => undefined,
      attachPushedTo: async () => undefined,
      setStatus: async (id: string, status: string) => void log.push(`${id}:${status}`),
      runSettled: async () => undefined,
      fanInAfterSettle: async () => undefined,
      createSubtask: async () => ({ id: 'S', title: 's' }),
      subtaskStatuses: async () => [],
      completeSubtask: async () => 'ok',
      scheduleFollowUp: async () => undefined,
    },
    agents: { get: async (name: string) => ({ mode: name === 'admin' ? 'chat' : 'code' }) },
    executor: {
      run: async (ctx: { taskId: string }) => {
        log.push(`${ctx.taskId}:run`);
        await new Promise<void>((r) => gates.set(ctx.taskId, r));
        log.push(`${ctx.taskId}:end`);
        return { reported: 'done', errored: false, timedOut: false };
      },
    },
    preview: { stop: () => undefined },
    verification: { verify: async () => ({ ran: false, ok: true, output: '' }) },
    github: { publishResult: async () => null, pushSharedWorkspace: async () => null },
    worktrees: {
      createForTask: async (p: ProjectContext, id: string) => ({ worktreePath: `/wt/${p.slug}/${id}`, branch: `agent/task-${id}` }),
      useSharedRepo: async (p: ProjectContext) => ({ worktreePath: p.repoPath, branch: 'main' }),
    },
    approvals: { continuationCount: async () => 0, requestContinuation: async () => undefined },
  });
  const process = (svc as unknown as { process: (d: { taskId: string }) => Promise<void> }).process.bind(svc);
  const settle = () => new Promise<void>((r) => setTimeout(r, 5));
  const open = async (id: string) => {
    gates.get(id)!();
    gates.delete(id);
    await settle();
  };
  return { process, log, open, settle, running: () => [...gates.keys()], concurrency, checkouts };
}

const shared = (id: string, slug: string): ProjectContext => project({ id, slug, name: slug, isDefault: slug === 'default', repoPath: `/repos/${slug}`, isolation: 'shared', workspaceRoot: `/ws/${slug}`, verifyCommands: [] });

describe('TaskWorkerService — projects and the per-project lock', () => {
  it('two tasks of one shared-mode project run one after the other, in arrival order', async () => {
    const w = makeMulti({ A: shared('A', 'a') }, { t1: { projectId: 'A' }, t2: { projectId: 'A' } });
    const p1 = w.process({ taskId: 't1' });
    const p2 = w.process({ taskId: 't2' });
    await w.settle();
    expect(w.running()).toEqual(['t1']); // t2 waits for the lock
    await w.open('t1');
    expect(w.running()).toEqual(['t2']);
    await w.open('t2');
    await Promise.all([p1, p2]);
    expect(w.log).toEqual(['t1:run', 't1:end', 't1:review', 't2:run', 't2:end', 't2:review']);
  });

  it('a waiting task lends its slot (concurrency +1) and takes it back once it holds the lock', async () => {
    const w = makeMulti({ A: shared('A', 'a') }, { t1: { projectId: 'A' }, t2: { projectId: 'A' } });
    const p1 = w.process({ taskId: 't1' });
    const p2 = w.process({ taskId: 't2' });
    await w.settle();
    expect(w.concurrency).toEqual([3]); // base 2 + one waiter
    await w.open('t1');
    expect(w.concurrency).toEqual([3, 2]); // the waiter acquired: back to the base
    await w.open('t2');
    await Promise.all([p1, p2]);
  });

  it('tasks of two shared-mode projects run side by side', async () => {
    const w = makeMulti({ A: shared('A', 'a'), B: shared('B', 'b') }, { t1: { projectId: 'A' }, t2: { projectId: 'B' } });
    const p1 = w.process({ taskId: 't1' });
    const p2 = w.process({ taskId: 't2' });
    await w.settle();
    expect([...w.running()].sort()).toEqual(['t1', 't2']);
    expect(w.concurrency).toEqual([]); // nobody waited
    await w.open('t2');
    await w.open('t1');
    await Promise.all([p1, p2]);
  });

  it('worktree-mode tasks of one project and chat turns never take the lock', async () => {
    const wt = project({ id: 'W', slug: 'w', isolation: 'worktree', repoPath: '/repos/w', workspaceRoot: '/ws/w', verifyCommands: [] });
    const w = makeMulti({ W: wt, A: shared('A', 'a') }, { t1: { projectId: 'W' }, t2: { projectId: 'W' }, t3: { projectId: 'A' }, c1: { projectId: 'A', chat: true } });
    const all = ['t1', 't2', 't3', 'c1'].map((taskId) => w.process({ taskId }));
    await w.settle();
    expect([...w.running()].sort()).toEqual(['c1', 't1', 't2', 't3']);
    for (const id of ['t1', 't2', 't3', 'c1']) await w.open(id);
    await Promise.all(all);
  });

  it('a lead does not hold the lock while it waits for its subtasks: the subtask runs after the lead\'s run returned', async () => {
    const w = makeMulti({ A: shared('A', 'a') }, { lead: { projectId: 'A' }, sub: { projectId: 'A', parentId: 'lead' } });
    const pl = w.process({ taskId: 'lead' });
    await w.settle();
    const ps = w.process({ taskId: 'sub' }); // the lead created it mid-run
    await w.settle();
    expect(w.running()).toEqual(['lead']);
    await w.open('lead'); // the lead's run returns (it would be awaiting subtasks) → the lock is free
    expect(w.running()).toEqual(['sub']);
    await w.open('sub');
    await Promise.all([pl, ps]);
    expect(w.log.filter((l) => l.endsWith(':run'))).toEqual(['lead:run', 'sub:run']);
  });

  it('checkouts: the project\'s repo in shared mode, a nested worktree per task otherwise, work/ for a docs project (no git)', async () => {
    const docsRoot = await mkdtemp(join(tmpdir(), 'lds-docs-'));
    try {
      const docs = project({ id: 'D', slug: 'd', kind: 'docs', isolation: 'shared', workspaceRoot: docsRoot, verifyCommands: [] });
      const wt = project({ id: 'W', slug: 'w', isolation: 'worktree', repoPath: '/repos/w', workspaceRoot: '/ws/w', verifyCommands: [] });
      const w = makeMulti({ D: docs, W: wt, A: shared('A', 'a') }, { d1: { projectId: 'D' }, w1: { projectId: 'W' }, a1: { projectId: 'A' } });
      const all = ['d1', 'w1', 'a1'].map((taskId) => w.process({ taskId }));
      await w.settle();
      for (const id of ['d1', 'w1', 'a1']) await w.open(id);
      await Promise.all(all);
      expect([...w.checkouts].sort()).toEqual([`a1:/repos/a@main`, `d1:${join(docsRoot, 'work')}@`, 'w1:/wt/w/w1@agent/task-w1']);
      expect(existsSync(join(docsRoot, 'work'))).toBe(true);
    } finally {
      await rm(docsRoot, { recursive: true, force: true });
    }
  });
});
