import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks.service';

// followUp() looks the discussion service up lazily; none is active in these tests.
vi.mock('../discussion/discussion.service', () => ({ DiscussionService: class DiscussionService {} }));

/**
 * Follow-ups and the task's status must agree even when two arrive at once (X-Q-1),
 * a settled run must drain its queue only once the worker is fully out (X-Q-3), and a
 * cancelled / finished task must never be resumed by a late job or a stale approval
 * (X-Q-5 / E-35).
 */
type Row = { id: string; status: string; [k: string]: unknown };

function make(row: Row) {
  const calls: string[] = [];
  const rows = [row];
  let pending: { id: string; taskId: string; text: string; attachments: string; references: string; createdAt: Date }[] = [];
  let seq = 0;
  const matches = (r: Row, where: { id: string; status?: { in?: string[]; notIn?: string[] } }) => {
    if (r.id !== where.id) return false;
    if (where.status?.in && !where.status.in.includes(r.status)) return false;
    if (where.status?.notIn && where.status.notIn.includes(r.status)) return false;
    return true;
  };
  const prisma = {
    task: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
        calls.push(`task.update:${data.status}`);
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({ where, data }: { where: { id: string; status?: { in?: string[]; notIn?: string[] } }; data: { status: string } }) => {
        calls.push(`task.updateMany:${data.status}`);
        const r = rows.find((x) => matches(x, where));
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    pendingFollowUp: {
      count: async () => pending.length,
      create: async ({ data }: { data: { taskId: string; text: string; attachments: string; references: string } }) => {
        calls.push(`pending.create:${data.text}`);
        const row = { id: `f${++seq}`, createdAt: new Date(), ...data };
        pending.push(row);
        return row;
      },
      findFirst: async () => pending[0] ?? null,
      findMany: async () => pending,
      delete: async ({ where }: { where: { id: string } }) => {
        pending = pending.filter((p) => p.id !== where.id);
      },
      deleteMany: async () => {
        const n = pending.length;
        pending = [];
        return { count: n };
      },
    },
    agentEvent: { findFirst: async () => null },
  };
  const svc = Object.create(TasksService.prototype) as TasksService & Record<string, unknown>;
  Object.assign(svc, {
    prisma,
    logger: { log: () => undefined, warn: () => undefined },
    queue: {
      removeForTask: async () => void calls.push('queue.removeForTask'),
      enqueue: async (d: { taskId: string; followUpPrompt?: string }) => void calls.push(`queue.enqueue:${d.followUpPrompt ?? 'initial'}`),
    },
    executor: { cancel: () => void calls.push('executor.cancel') },
    bus: { publish: () => undefined },
    attachments: { list: async () => [] },
    moduleRef: { get: () => null },
    runs: new Map(),
    get: async (id: string) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error('not found');
      return r;
    },
  });
  return { svc: svc as unknown as TasksService, calls, rows, pending: () => pending };
}

const row = (status: string): Row => ({ id: 'T', status, prompt: 'p', title: 't', agentName: null, parentId: null, error: null, branch: null, worktreePath: null, createdAt: new Date(), updatedAt: new Date() });

describe('TasksService.followUp — one run per task', () => {
  it('two follow-ups to a finished task at once → one job, the other is held in the queue (X-Q-1)', async () => {
    const { svc, calls, rows, pending } = make(row('review'));
    await Promise.all([svc.followUp('T', 'first'), svc.followUp('T', 'second')]);
    expect(calls.filter((c) => c.startsWith('queue.enqueue'))).toEqual(['queue.enqueue:first']);
    expect(pending().map((p) => p.text)).toEqual(['second']);
    expect(rows[0]!.status).toBe('queued');
  });

  it('a follow-up to a running task is held', async () => {
    const { svc, calls, pending } = make(row('running'));
    const r = await svc.followUp('T', 'later');
    expect(r.queued).toBe(true);
    expect(calls).not.toContain('queue.enqueue:later');
    expect(pending().map((p) => p.text)).toEqual(['later']);
  });

  it('a follow-up to a finished task runs now', async () => {
    const { svc, calls, rows } = make(row('stalled'));
    const r = await svc.followUp('T', 'go');
    expect(r.queued).toBe(false);
    expect(calls).toContain('queue.enqueue:go');
    expect(rows[0]!.status).toBe('queued');
  });
});

describe('TasksService — the worker entry and settle', () => {
  it('startRunning: queued → running, and the run is tracked until runSettled', async () => {
    const { svc, rows } = make(row('queued'));
    expect(await svc.startRunning('T')).toBe('started');
    expect(rows[0]!.status).toBe('running');
    expect(svc.isRunning('T')).toBe(true);
    await svc.runSettled('T');
    expect(svc.isRunning('T')).toBe(false);
  });

  it('startRunning: a task already running (or waiting on an approval) is busy — a second run is never started', async () => {
    for (const status of ['running', 'needs_approval']) {
      const { svc, rows } = make(row(status));
      expect(await svc.startRunning('T')).toBe('busy');
      expect(rows[0]!.status).toBe(status);
    }
  });

  it('startRunning: cancelled, done or missing → gone', async () => {
    for (const status of ['cancelled', 'done']) {
      const { svc, rows } = make(row(status));
      expect(await svc.startRunning('T')).toBe('gone');
      expect(rows[0]!.status).toBe(status);
    }
    expect(await make(row('queued')).svc.startRunning('nope')).toBe('gone');
  });

  it('a terminal status written while the run is still in the worker does NOT drain the queue; runSettled does (X-Q-3)', async () => {
    const { svc, calls, pending } = make(row('queued'));
    await svc.startRunning('T');
    await svc.followUp('T', 'next'); // held: the task is running
    expect(pending()).toHaveLength(1);
    await svc.setStatus('T', 'review');
    expect(pending()).toHaveLength(1); // still held — the worker is not out yet
    expect(calls).not.toContain('queue.enqueue:next');
    await svc.runSettled('T');
    expect(pending()).toHaveLength(0);
    expect(calls).toContain('queue.enqueue:next');
  });

  it('a terminal status written outside a run (e.g. an orphan reconcile, a denied continuation) drains at once', async () => {
    const { svc, calls, pending } = make(row('running'));
    await svc.followUp('T', 'next');
    await svc.setStatus('T', 'stalled', 'x');
    expect(pending()).toHaveLength(0);
    expect(calls).toContain('queue.enqueue:next');
  });

  it('setStatus on a deleted task is a no-op, not an error (E-23)', async () => {
    const { svc } = make(row('running'));
    await expect(svc.setStatus('nope', 'failed', 'x')).resolves.toBeNull();
  });
});

describe('TasksService — a cancelled task is never resumed', () => {
  it('continueRun on a cancelled task does not queue a job (a stale continuation approval, X-Q-5)', async () => {
    const { svc, calls, rows } = make(row('cancelled'));
    await svc.continueRun('T', 'go on');
    expect(calls).not.toContain('queue.enqueue:go on');
    expect(rows[0]!.status).toBe('cancelled');
  });

  it('continueRun on a task waiting for the continuation approval queues it', async () => {
    const { svc, calls, rows } = make(row('needs_approval'));
    await svc.continueRun('T', 'go on');
    expect(calls).toContain('queue.enqueue:go on');
    expect(rows[0]!.status).toBe('queued');
  });

  it('needs_approval cannot be written over a cancelled (or any finished) task (E-35)', async () => {
    for (const status of ['cancelled', 'done', 'stalled']) {
      const { svc, rows } = make(row(status));
      await svc.setStatus('T', 'needs_approval');
      expect(rows[0]!.status).toBe(status);
    }
    const { svc, rows } = make(row('running'));
    await svc.setStatus('T', 'needs_approval');
    expect(rows[0]!.status).toBe('needs_approval');
  });

  it('a held follow-up is dropped with the cancel; nothing runs afterwards', async () => {
    const { svc, calls, pending, rows } = make(row('running'));
    await svc.followUp('T', 'later');
    await svc.cancel('T');
    expect(pending()).toHaveLength(0);
    expect(rows[0]!.status).toBe('cancelled');
    expect(calls.filter((c) => c.startsWith('queue.enqueue'))).toEqual([]);
    expect(await svc.startRunning('T')).toBe('gone');
  });
});
