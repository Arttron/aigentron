import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelManagerService } from './channel-manager.service';
import { ChannelGateway } from './channel-gateway.service';

function make(opts: { muted?: boolean; hasThread?: boolean } = {}) {
  const setActivity = vi.fn(async () => undefined);
  const dest = {
    destForTask: vi.fn(async () => (opts.hasThread === false ? null : { channelId: 'c1', chatId: '42', own: true })),
    prefs: vi.fn(async () => ({ muted: opts.muted ?? false, progress: false, voice: false })),
  };
  const gateway = new ChannelGateway({} as never);
  gateway.adapters.set('c1', { setActivity, stop: async () => undefined } as never);
  const svc = new ChannelManagerService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, gateway, dest as never);
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
