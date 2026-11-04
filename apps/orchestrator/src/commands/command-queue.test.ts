import { describe, expect, it } from 'vitest';
import { CommandQueue, QueueAbortedError } from './command-queue';

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));

describe('CommandQueue', () => {
  it('runs one at a time with one slot, in order of arrival', async () => {
    const q = new CommandQueue(() => 1);
    const order: string[] = [];
    const a = deferred();
    const b = deferred();
    const ra = q.run({ taskId: 't1', label: 'a' }, async () => (order.push('a start'), await a.promise, order.push('a end')));
    const rb = q.run({ taskId: 't2', label: 'b' }, async () => (order.push('b start'), await b.promise, order.push('b end')));
    await tick();
    expect(order).toEqual(['a start']);
    expect(q.snapshot().waiting.map((e) => e.label)).toEqual(['b']);
    a.resolve();
    await ra;
    await tick();
    expect(order).toEqual(['a start', 'a end', 'b start']);
    b.resolve();
    await rb;
    expect(q.snapshot()).toEqual({ running: [], waiting: [] });
  });

  it('runs as many at once as the slots allow, and a raised limit starts waiting ones', async () => {
    let slots = 1;
    const q = new CommandQueue(() => slots);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((g, i) => q.run({ taskId: 't', label: String(i) }, async () => (started.push(i), await g.promise)));
    await tick();
    expect(started).toEqual([0]);
    slots = 3;
    q.slotsChanged();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
  });

  it('holds a command at the gate and says why; the slot stays taken meanwhile', async () => {
    const open = deferred();
    const q = new CommandQueue(() => 1, async (onWait) => {
      onWait('the machine is busy');
      await open.promise;
    });
    const told: Array<string | null> = [];
    let ran = false;
    const r = q.run({ taskId: 't', label: 'x' }, async () => void (ran = true), { onWait: (i) => told.push(i.reason) });
    await tick();
    expect(ran).toBe(false);
    expect(told).toContain('the machine is busy');
    expect(q.snapshot().running[0]?.state).toBe('starting');
    open.resolve();
    await r;
    expect(ran).toBe(true);
  });

  it('cancels a waiting command without running it, and tells the ones behind that they moved up', async () => {
    const q = new CommandQueue(() => 1);
    const hold = deferred();
    const ahead: number[] = [];
    void q.run({ taskId: 't1', label: 'first' }, () => hold.promise);
    const ctrl = new AbortController();
    const second = q.run({ taskId: 't2', label: 'second' }, async () => 'never', { signal: ctrl.signal });
    const third = q.run({ taskId: 't3', label: 'third' }, async () => 'ok', { onWait: (i) => ahead.push(i.ahead) });
    await tick();
    ctrl.abort();
    await expect(second).rejects.toBeInstanceOf(QueueAbortedError);
    expect(ahead.at(-1)).toBe(1); // only the running one is ahead now
    hold.resolve();
    await expect(third).resolves.toBe('ok');
  });

  it('aborts a running command through its signal; cancelTask stops every command of that task', async () => {
    const q = new CommandQueue(() => 2);
    const seen: boolean[] = [];
    const exec = (signal: AbortSignal) => new Promise<void>((_, rej) => signal.addEventListener('abort', () => (seen.push(true), rej(new Error('killed')))));
    const a = q.run({ taskId: 'T', label: 'a' }, exec);
    const b = q.run({ taskId: 'T', label: 'b' }, exec);
    const c = q.run({ taskId: 'OTHER', label: 'c' }, async () => 'fine');
    await tick();
    expect(q.cancelTask('T')).toBe(2);
    await expect(a).rejects.toThrow('killed');
    await expect(b).rejects.toThrow('killed');
    await expect(c).resolves.toBe('fine');
    expect(seen).toHaveLength(2);
  });

  it('a failing command frees its slot', async () => {
    const q = new CommandQueue(() => 1);
    const bad = q.run({ taskId: 't', label: 'bad' }, async () => {
      throw new Error('boom');
    });
    const good = q.run({ taskId: 't', label: 'good' }, async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
  });

  it('cancelling a command that is held at the gate frees its slot at once (the gate gets the signal)', async () => {
    const q = new CommandQueue(
      () => 1,
      (_onWait, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())), // a gate that never opens by itself
    );
    const held = q.run({ taskId: 't1', label: 'held', owner: 'A' }, async () => 'never');
    const next = q.run({ taskId: 't2', label: 'next', owner: 'B' }, async () => 'ran');
    await tick();
    expect(q.snapshot().running[0]?.state).toBe('starting');
    expect(q.cancelOwner('A')).toBe(1);
    await expect(held).rejects.toBeInstanceOf(QueueAbortedError);
    q.cancelOwner('B'); // the second would be held at the same kind of gate: stop the test cleanly
    await expect(next).rejects.toBeInstanceOf(QueueAbortedError);
  });

  it('cancelOwner leaves the commands of other owners alone', async () => {
    const q = new CommandQueue(() => 2);
    const a = deferred();
    const ra = q.run({ taskId: 't', label: 'a', owner: 'A' }, () => a.promise);
    const rb = q.run({ taskId: 't', label: 'b', owner: 'B' }, async () => 'b done');
    await tick();
    expect(q.cancelOwner('B')).toBe(0); // already finished
    expect(q.cancelOwner('A')).toBe(1);
    a.resolve();
    await ra.catch(() => undefined);
    await expect(rb).resolves.toBe('b done');
  });
});
