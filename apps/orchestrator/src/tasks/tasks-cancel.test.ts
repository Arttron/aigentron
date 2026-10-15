import { describe, expect, it } from 'vitest';
import { TasksService } from './tasks.service';

/**
 * The ORDER of what cancel/markDone/delete do decides whether a stopped task can
 * come back to life (E-03 / X-Q-2): pending follow-ups must be gone BEFORE the
 * terminal status drains them, queued jobs before the status, and the abort of
 * the live run last.
 */
type Row = { id: string; status: string; branch: string | null; worktreePath: string | null; createdAt: Date; updatedAt: Date; [k: string]: unknown };

function make(row: Row, pending: { id: string; taskId: string }[] = []) {
  const calls: string[] = [];
  const rows = [row];
  let followUps = [...pending];
  const prisma = {
    task: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
        calls.push(`task.update:${data.status}`);
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({ where, data }: { where: { id: string; status: { notIn: string[] } }; data: { status: string } }) => {
        calls.push(`task.updateMany:${data.status}`);
        const r = rows.find((x) => x.id === where.id && !where.status.notIn.includes(x.status));
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        calls.push('task.delete');
        const i = rows.findIndex((r) => r.id === where.id);
        return rows.splice(i, 1)[0];
      },
    },
    pendingFollowUp: {
      deleteMany: async ({ where }: { where: { taskId: string } }) => {
        calls.push('pendingFollowUp.deleteMany');
        const n = followUps.filter((f) => f.taskId === where.taskId).length;
        followUps = followUps.filter((f) => f.taskId !== where.taskId);
        return { count: n };
      },
      findFirst: async () => {
        calls.push('pendingFollowUp.findFirst');
        return followUps[0] ?? null;
      },
      findMany: async () => followUps,
      delete: async () => undefined,
      count: async () => followUps.length,
    },
    agentEvent: { findFirst: async () => null },
  };
  const svc = Object.create(TasksService.prototype) as TasksService & Record<string, unknown>;
  Object.assign(svc, {
    prisma,
    logger: { log: () => undefined, warn: () => undefined },
    queue: {
      removeForTask: async () => void calls.push('queue.removeForTask'),
      enqueue: async () => void calls.push('queue.enqueue'),
    },
    executor: { cancel: () => void calls.push('executor.cancel') },
    bus: { publish: () => undefined },
    worktrees: { cleanup: async () => void calls.push('worktrees.cleanup') },
    attachments: { remove: async () => undefined, list: async () => [] },
    get: async (id: string) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error('not found');
      return r;
    },
  });
  return { svc: svc as unknown as TasksService, calls, rows, followUps: () => followUps };
}

const running = (): Row => ({ id: 'T', status: 'running', branch: null, worktreePath: null, createdAt: new Date(), updatedAt: new Date(), prompt: 'p', title: 't', agentName: null, parentId: null, error: null, createdById: null, prUrl: null, pushedTo: null, titleState: 'auto' });

describe('TasksService.cancel', () => {
  it('drops pending follow-ups, then queued jobs, then marks cancelled, then aborts the run — in that order', async () => {
    const { svc, calls, rows, followUps } = make(running(), [{ id: 'f1', taskId: 'T' }, { id: 'f2', taskId: 'T' }]);
    await svc.cancel('T');
    expect(calls).toEqual(['pendingFollowUp.deleteMany', 'queue.removeForTask', 'task.update:cancelled', 'pendingFollowUp.findFirst', 'executor.cancel']);
    expect(rows[0]!.status).toBe('cancelled');
    expect(followUps()).toEqual([]);
    expect(calls).not.toContain('queue.enqueue'); // the drain found nothing → no new run
    expect(calls).not.toContain('task.update:queued');
  });

  it('a finished task is left alone', async () => {
    const { svc, calls } = make({ ...running(), status: 'review' });
    await svc.cancel('T');
    expect(calls).toEqual([]);
  });
});

describe('TasksService.markDone / delete', () => {
  it('markDone drops queued jobs before the terminal status', async () => {
    const { svc, calls } = make({ ...running(), status: 'review' });
    await svc.markDone('T');
    expect(calls.slice(0, 2)).toEqual(['queue.removeForTask', 'task.update:done']);
  });

  it('delete drops queued jobs and aborts the run even for a finished task', async () => {
    const { svc, calls } = make({ ...running(), status: 'done' });
    await svc.delete('T');
    expect(calls.indexOf('queue.removeForTask')).toBeLessThan(calls.indexOf('task.delete'));
    expect(calls.indexOf('executor.cancel')).toBeLessThan(calls.indexOf('task.delete'));
  });
});

describe('TasksService.startRunning (the worker entry guard)', () => {
  it('moves a queued task to running', async () => {
    const { svc, rows } = make({ ...running(), status: 'queued' });
    expect(await svc.startRunning('T')).toBe(true);
    expect(rows[0]!.status).toBe('running');
  });
  it('refuses a cancelled or done task and a missing one', async () => {
    for (const status of ['cancelled', 'done']) {
      const { svc, rows } = make({ ...running(), status });
      expect(await svc.startRunning('T')).toBe(false);
      expect(rows[0]!.status).toBe(status);
    }
    const { svc } = make(running());
    expect(await svc.startRunning('nope')).toBe(false);
  });
});
