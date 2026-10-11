import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelManagerService } from './channel-manager.service';

function make(opts: { muted?: boolean; hasThread?: boolean } = {}) {
  const setActivity = vi.fn(async () => undefined);
  const channels = {
    threadForTask: vi.fn(async () => (opts.hasThread === false ? null : { channel: { id: 'c1' }, externalThreadId: '42' })),
  };
  const prisma = {
    task: { findUnique: vi.fn(async () => ({ parentId: null })) },
    channelChatState: { findUnique: vi.fn(async () => ({ muted: opts.muted ?? false })) },
  };
  const svc = new ChannelManagerService(prisma as never, {} as never, channels as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  (svc as unknown as { adapters: Map<string, unknown> }).adapters.set('c1', { setActivity, stop: () => undefined });
  const call = (taskId: string, status: string) => (svc as unknown as { onTaskActivity: (t: string, s: string) => Promise<void> }).onTaskActivity(taskId, status);
  return { svc, setActivity, call };
}

describe('"typing…" while an agent works', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows typing as soon as the task runs, repeats it, and stops when the task settles', async () => {
    const { call, setActivity, svc } = make();
    await call('t1', 'running');
    expect(setActivity).toHaveBeenCalledWith('42', 'typing');
    const first = setActivity.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(setActivity.mock.calls.length).toBeGreaterThanOrEqual(first + 2);
    await call('t1', 'done');
    const after = setActivity.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(setActivity.mock.calls.length).toBe(after);
    svc.onModuleDestroy();
  });

  it('stops while the agent waits for a human (approval), and is not started twice', async () => {
    const { call, setActivity, svc } = make();
    await call('t1', 'running');
    await call('t1', 'running');
    const n = setActivity.mock.calls.length;
    await call('t1', 'needs_approval');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(setActivity.mock.calls.length).toBe(n);
    svc.onModuleDestroy();
  });

  it('stays silent for a muted chat and for a task with no chat', async () => {
    const muted = make({ muted: true });
    await muted.call('t1', 'running');
    expect(muted.setActivity).not.toHaveBeenCalled();
    const none = make({ hasThread: false });
    await none.call('t1', 'running');
    expect(none.setActivity).not.toHaveBeenCalled();
  });
});
