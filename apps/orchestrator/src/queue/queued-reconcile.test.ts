import { describe, expect, it } from 'vitest';
import { queuedFate } from './queued-reconcile';

describe('queuedFate', () => {
  it('a task with a job is left alone', () => {
    expect(queuedFate({ hasJob: true, sessions: 0 })).toBe('keep');
    expect(queuedFate({ hasJob: true, sessions: 3 })).toBe('keep');
  });
  it('a task that never ran and lost its job is queued again', () => {
    expect(queuedFate({ hasJob: false, sessions: 0 })).toBe('requeue');
  });
  it('a task that ran before lost a follow-up we cannot recreate: it is stalled, resumable', () => {
    expect(queuedFate({ hasJob: false, sessions: 2 })).toBe('stall');
  });
});

import { TaskWorkerService } from './task-worker.service';

describe('TaskWorkerService.reconcileQueued', () => {
  function make(queued: { id: string; agentName: string | null; sessions: number }[], jobs: Set<string>) {
    const calls: string[] = [];
    const w = Object.create(TaskWorkerService.prototype) as TaskWorkerService;
    Object.assign(w, {
      logger: { warn: () => undefined, log: () => undefined },
      tasks: {
        queuedTasksBefore: async () => queued,
        requeue: async (id: string) => void calls.push(`requeue:${id}`),
        setStatus: async (id: string, s: string, e?: string) => void calls.push(`status:${id}:${s}:${(e ?? '').slice(0, 20)}`),
        wakeIfSubtasksDone: async (id: string) => void calls.push(`wake:${id}`),
      },
      queue: { hasJobFor: async (id: string, o?: { includeActive?: boolean }) => jobs.has(id) || (o?.includeActive === true && jobs.has(`${id}!active`)) },
    });
    return { w, calls };
  }

  it('re-queues a task that never ran, stalls one that did, leaves one with a job', async () => {
    const { w, calls } = make(
      [
        { id: 'never-ran', agentName: 'dev', sessions: 0 },
        { id: 'ran-before', agentName: 'dev', sessions: 2 },
        { id: 'has-job', agentName: 'dev', sessions: 0 },
      ],
      new Set(['has-job']),
    );
    expect(await w.reconcileQueued(0, false)).toEqual({ requeued: 1, stalled: 1 });
    // a stalled lead is also offered its "all subtasks finished" wake-up (a no-op unless it was waiting for them)
    expect(calls).toEqual(['requeue:never-ran', 'status:ran-before:stalled:The server restarted', 'wake:ran-before']);
  });

  it('a claimed (running / waiting for the project lock) job counts as alive only for the periodic sweep', async () => {
    const jobs = new Set(['T!active']);
    const boot = make([{ id: 'T', agentName: null, sessions: 0 }], jobs);
    expect(await boot.w.reconcileQueued(0, false)).toEqual({ requeued: 1, stalled: 0 }); // at boot a claimed job belongs to a dead process
    const sweep = make([{ id: 'T', agentName: null, sessions: 0 }], jobs);
    expect(await sweep.w.reconcileQueued(600_000, true)).toEqual({ requeued: 0, stalled: 0 });
  });

  it('never throws', async () => {
    const w = Object.create(TaskWorkerService.prototype) as TaskWorkerService;
    Object.assign(w, { logger: { warn: () => undefined }, tasks: { queuedTasksBefore: async () => { throw new Error('db down'); } }, queue: {} });
    expect(await w.reconcileQueued(0, false)).toEqual({ requeued: 0, stalled: 0 });
  });
});
