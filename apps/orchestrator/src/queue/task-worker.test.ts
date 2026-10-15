import { describe, expect, it } from 'vitest';
import { TaskWorkerService } from './task-worker.service';

/** A job that outlived its task (cancelled / done / deleted) must be dropped before anything runs (X-Q-2). */
function make(startRunning: boolean, status = 'queued') {
  const calls: string[] = [];
  const svc = Object.create(TaskWorkerService.prototype) as TaskWorkerService & Record<string, unknown>;
  Object.assign(svc, {
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    config: { agentDir: '/agent', workspaceShared: false, requireStatusReport: false, maxContinuations: 1 },
    tasks: {
      startRunning: async (id: string) => {
        calls.push(`startRunning:${id}`);
        return startRunning;
      },
      setStatus: async (id: string, s: string) => void calls.push(`setStatus:${s}`),
      get: async (id: string) => ({ id, status, agentName: 'admin', parentId: null, worktreePath: null, branch: null }),
      fanInAfterSettle: async () => void calls.push('fanIn'),
    },
    agents: { get: async () => ({ mode: 'chat' }) },
    executor: {
      run: async () => {
        calls.push('executor.run');
        return { reported: 'done', errored: false, timedOut: false };
      },
    },
    preview: { stop: () => undefined },
  });
  const process = (svc as unknown as { process: (d: { taskId: string }) => Promise<void> }).process.bind(svc);
  return { process, calls };
}

describe('TaskWorkerService.process', () => {
  it('drops the job when the task may not start (cancelled / done / deleted) — no run, no status write', async () => {
    const { process, calls } = make(false);
    await process({ taskId: 'T' });
    expect(calls).toEqual(['startRunning:T']);
  });

  it('runs the task once the guarded transition to running succeeded', async () => {
    const { process, calls } = make(true, 'running');
    await process({ taskId: 'T' });
    expect(calls).toEqual(['startRunning:T', 'executor.run', 'setStatus:review', 'fanIn']);
  });
});
