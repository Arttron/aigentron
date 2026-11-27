import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_GRANT_TOOL } from '@lds/shared';
import { LocalOsMcpService } from './local-os-mcp.service';

const binding = { deviceId: 'dev1', deviceLabel: 'MacBook', repo: { id: 'r1', path: '/Users/me/app' } };
const ctxOf = (taskId: string) => ({ taskId, projectId: 'p1', exp: Date.now() + 1e6 });

function setup(verdict: 'approved' | 'denied' = 'approved') {
  const request = vi.fn(async (_d: string, _op: string, _a: unknown) => ({ ok: true, data: { text: 'ok' } }) as { ok: boolean; data?: unknown; error?: string });
  const check = vi.fn(async (_i: unknown) => ({ allow: false, approvalId: 'ap1' }) as { allow: boolean; approvalId?: string; reason?: string });
  const waitForVerdict = vi.fn(async (_id: string) => ({ status: verdict }));
  const svc = new LocalOsMcpService({ request } as never, { resolveForProject: async () => [binding] } as never);
  (svc as unknown as { approvalsCache: unknown }).approvalsCache = { check, waitForVerdict };
  const work = (taskId: string, op = 'fs.edit', args: Record<string, unknown> = { path: 'a.go' }) => (svc as unknown as { work: (...a: unknown[]) => Promise<Record<string, unknown>> }).work(ctxOf(taskId), undefined, op, args);
  return { svc, request, check, waitForVerdict, work };
}

describe('changes on the person\'s computer: grant, lock, Stop', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('the first change in a folder asks for ONE grant card for this task, then the command goes to the daemon with the task named', async () => {
    const { check, request, work } = setup();
    await work('t1');
    await work('t1', 'exec.run', { command: 'go test ./...', timeoutSec: 60 });
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]![0]).toMatchObject({ taskId: 't1', toolName: LOCAL_GRANT_TOOL, toolInput: { repo: 'r1', folder: '/Users/me/app', computer: 'MacBook', level: 'write' } });
    expect(request).toHaveBeenCalledTimes(2);
    const [device, op, args] = request.mock.calls[1]!;
    expect([device, op]).toEqual(['dev1', 'exec.run']);
    expect(args).toMatchObject({ repo: 'r1', task: 't1', command: 'go test ./...', timeoutSec: 60 });
  });

  it('parallel first calls share one card', async () => {
    const { check, work } = setup();
    await Promise.all([work('t1'), work('t1'), work('t1')]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('another task is asked again; so is the same task after the grant expired', async () => {
    const { check, work, svc } = setup();
    await work('t1');
    svc.release('t1');
    await work('t2');
    expect(check).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 4 * 3_600_000);
    await work('t2');
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('a refusal says so, sends nothing, and frees the folder for the next task', async () => {
    const { request, work } = setup('denied');
    await expect(work('t1')).rejects.toThrow(/did not allow changes in \/Users\/me\/app on MacBook/);
    expect(request).not.toHaveBeenCalled();
    await expect(work('t2')).rejects.toThrow(/did not allow/); // not "another task is working"
  });

  it('a call the approvals refuse outright is refused with its reason', async () => {
    const { check, work } = setup();
    check.mockResolvedValueOnce({ allow: false, reason: 'no' });
    await expect(work('t1')).rejects.toThrow(/Not allowed: no/);
  });

  it('one task at a time in a folder, free again after 3 idle minutes or when the task is released', async () => {
    const { work, svc } = setup();
    await work('t1');
    await expect(work('t2')).rejects.toThrow(/Another task is working in \/Users\/me\/app/);
    vi.setSystemTime(Date.now() + 4 * 60_000);
    await expect(work('t2')).resolves.toBeDefined();
    svc.release('t2');
    await expect(work('t1')).resolves.toBeDefined();
  });

  it('Stop: the task may not change or run anything for ten minutes, what runs is cut off, and Allow lifts it', async () => {
    const { work, svc, request } = setup();
    await work('t1');
    request.mockClear();
    svc.stop('t1');
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('dev1', 'exec.cancel', { task: 't1' }, expect.any(Number)));
    await expect(work('t1')).rejects.toThrow(/pressed Stop/);
    await expect(work('t2')).resolves.toBeDefined(); // only that task was stopped
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(work('t1')).resolves.toBeDefined();
    svc.stop();
    expect(svc.allStopped).toBe(true);
    await expect(work('t3')).rejects.toThrow(/pressed Stop/);
    svc.allow();
    expect(svc.allStopped).toBe(false);
    await expect(work('t3')).resolves.toBeDefined();
  });

  it('a daemon error comes back as the error (writes off on that computer, a refused path)', async () => {
    const { work, request } = setup();
    request.mockResolvedValueOnce({ ok: false, error: 'writes are off on this computer: the owner can allow changes with `aigentron writes on`' });
    await expect(work('t1')).rejects.toThrow(/aigentron writes on/);
  });
});

describe('the local-os tools', () => {
  it('lists the reading tools, the working tools and the commit tool', () => {
    const svc = new LocalOsMcpService({} as never, {} as never);
    const server = (svc as unknown as { build: (c: unknown) => { _registeredTools?: Record<string, unknown> } }).build(ctxOf('t'));
    const names = Object.keys(server._registeredTools ?? {});
    expect(names).toEqual(expect.arrayContaining(['local_repos', 'local_status', 'local_diff', 'local_log', 'local_read', 'local_list', 'local_search', 'local_edit', 'local_write', 'local_bash', 'local_commit']));
  });
});
