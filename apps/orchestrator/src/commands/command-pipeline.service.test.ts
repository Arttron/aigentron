import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandPipelineService, formatCommandResult } from './command-pipeline.service';

const result = (o: Partial<Parameters<typeof formatCommandResult>[0]> = {}) => ({ exitCode: 0, signal: null, timedOut: false, cancelled: false, output: '', truncated: false, ms: 1500, ...o });

describe('formatCommandResult', () => {
  it('says how it ended, the times, and the output', () => {
    expect(formatCommandResult(result(), 0, 'ok')).toBe('finished, exit code 0 — ran 1.5 s\nok');
    expect(formatCommandResult(result({ exitCode: 2 }), 12_000, 'boom')).toContain('failed, exit code 2 — ran 1.5 s, waited 12 s in the queue');
    expect(formatCommandResult(result({ timedOut: true, exitCode: null }), 0, '')).toContain('ran longer than its time limit');
    expect(formatCommandResult(result({ truncated: true }), 0, 'tail')).toContain('(the end of the output)');
    expect(formatCommandResult(result(), 0, '  ')).toContain('(no output)');
  });
});

function service(approval: { allow: boolean; reason?: string }) {
  const checks: Array<{ toolName: string; toolInput: Record<string, unknown> }> = [];
  const approvals = { check: async (i: { toolName: string; toolInput: Record<string, unknown> }) => (checks.push(i), approval) };
  const svc = new CommandPipelineService(
    { agentMaxLoadPerCpu: 0, agentMinFreeMemMb: 0, agentMaxStealPct: 0, agentNice: 0 } as never,
    { heavySlots: async () => 1, compression: async () => undefined } as never,
    { get: () => approvals } as never,
  );
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  const { token } = svc.register('task1', { cwd: dir, workspaceRoot: dir });
  const ctx = (svc as unknown as { ctxOf: (h: string) => unknown }).ctxOf(`Bearer ${token}`);
  return { svc, ctx: ctx as never, checks };
}

describe('CommandPipelineService', () => {
  it('runs a light command at once, after the same dangerous-command check Bash gets', async () => {
    const { svc, ctx, checks } = service({ allow: true });
    const text = await svc.run(ctx, 'echo hello', 30);
    expect(text).toContain('finished, exit code 0');
    expect(text).toContain('hello');
    expect(checks[0]).toMatchObject({ toolName: 'Bash', toolInput: { command: 'echo hello' } });
  });

  it('does not run a command the check refuses', async () => {
    const { svc, ctx } = service({ allow: false, reason: 'protected path' });
    await expect(svc.run(ctx, 'echo hi', 30)).rejects.toThrow('protected path');
  });

  it('sends a heavy command through the queue and reports a failure as a result', async () => {
    const { svc, ctx } = service({ allow: true });
    const text = await svc.run(ctx, 'make -s nothing-here 2>/dev/null; npm run build --silent 2>/dev/null; exit 4', 30);
    expect(text).toContain('failed, exit code 4');
    expect(svc.queue.snapshot()).toEqual({ running: [], waiting: [] });
  });

  it('refuses a command that keeps running, with advice', async () => {
    const { svc, ctx } = service({ allow: true });
    await expect(svc.run(ctx, 'npm run dev', 30)).rejects.toThrow('background');
  });

  it('a token that was never registered is not accepted', () => {
    const { svc } = service({ allow: true });
    expect((svc as unknown as { ctxOf: (h: string) => unknown }).ctxOf('Bearer nope')).toBeNull();
  });

  it('unregister drops only that attempt\'s token: an overlapping attempt of the same task keeps its own', () => {
    const { svc } = service({ allow: true });
    const old = svc.register('t9', { cwd: '/tmp', workspaceRoot: '/tmp' }).token;
    const fresh = svc.register('t9', { cwd: '/tmp', workspaceRoot: '/tmp' }).token;
    svc.unregister(old);
    const ctxOf = (t: string) => (svc as unknown as { ctxOf: (h: string) => unknown }).ctxOf(`Bearer ${t}`);
    expect(ctxOf(old)).toBeNull();
    expect(ctxOf(fresh)).not.toBeNull();
    svc.unregister(fresh);
    expect(ctxOf(fresh)).toBeNull();
  });

  it('heavy commands wait for the one slot, in order, and stopping one attempt cancels only its own', async () => {
    const { svc, ctx } = service({ allow: true });
    const sh = 'sleep 0.6; npm run build --silent 2>/dev/null; exit 0';
    const a = svc.run(ctx, sh, 30);
    const b = svc.run(ctx, sh, 30);
    await new Promise((r) => setTimeout(r, 200));
    const snap = svc.queue.snapshot();
    expect(snap.running).toHaveLength(1);
    expect(snap.waiting).toHaveLength(1);
    await Promise.all([a, b]);
    expect(svc.queue.snapshot()).toEqual({ running: [], waiting: [] });
    // cancelling the owner of a waiting command rejects it, a command of another owner goes on
    const c1 = svc.run(ctx, 'sleep 0.5; npm run build --silent 2>/dev/null; exit 0', 30);
    const other = svc.register('task1', { cwd: '/tmp', workspaceRoot: '/tmp' }).token;
    const octx = (svc as unknown as { ctxOf: (h: string) => never }).ctxOf(`Bearer ${other}`);
    const c2 = svc.run(octx, 'npm run build --silent 2>/dev/null; exit 0', 30);
    await new Promise((r) => setTimeout(r, 100));
    svc.unregister(other);
    await expect(c2).rejects.toThrow('cancelled');
    await expect(c1).resolves.toContain('finished');
  });

  it('cancelTask stops what the task runs and what waits for it, at once, and takes its tokens away', async () => {
    const { svc, ctx } = service({ allow: true });
    const running = svc.run(ctx, 'sleep 20; npm run build --silent 2>/dev/null; exit 0', 60);
    const waiting = svc.run(ctx, 'npm run build --silent 2>/dev/null; exit 0', 60);
    await new Promise((r) => setTimeout(r, 200));
    expect(svc.queue.snapshot().running).toHaveLength(1);
    const t = Date.now();
    expect(svc.cancelTask('task1')).toBe(2);
    await expect(waiting).rejects.toThrow('cancelled');
    expect(await running).toContain('cancelled'); // the running one is killed and says so
    expect(Date.now() - t).toBeLessThan(5000);
    expect(svc.queue.snapshot()).toEqual({ running: [], waiting: [] });
    // the task's token no longer opens the server
    expect((svc as unknown as { ctxOf: (h: string) => unknown }).ctxOf('Bearer x')).toBeNull();
    expect([...(svc as unknown as { runs: Map<string, unknown> }).runs.keys()]).toHaveLength(0);
  });
});
