import { describe, expect, it } from 'vitest';
import { StartThrottle, autoNodeHeapMb, oomVictim, parseMeminfo, capacityVerdict, parseCpuStat, recommendConcurrency, stealBetween, waitForCapacity, type CapacitySample } from './capacity-gate';

const s = (over: Partial<CapacitySample> = {}): CapacitySample => ({ loadPerCpu: 0.5, load1: 1, cpus: 2, freeMemMb: 2000, stealPct: 0, ...over });

describe('capacityVerdict', () => {
  const limits = { maxLoadPerCpu: 1.5, minFreeMemMb: 300 };
  it('a calm machine is ok', () => {
    expect(capacityVerdict(s(), limits)).toEqual({ ok: true, reason: null });
  });
  it('holds a start while the load per CPU is over the limit', () => {
    const v = capacityVerdict(s({ loadPerCpu: 2.1, load1: 4.2 }), limits);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('load 4.2 on 2 CPU');
    expect(v.reason).toContain('limit 3.0');
  });
  it('holds a start while free memory is low', () => {
    expect(capacityVerdict(s({ freeMemMb: 120 }), limits)).toMatchObject({ ok: false, reason: expect.stringContaining('120 MB') });
  });
  it('0 switches a limit off', () => {
    expect(capacityVerdict(s({ loadPerCpu: 9, freeMemMb: 1 }), { maxLoadPerCpu: 0, minFreeMemMb: 0 }).ok).toBe(true);
  });
});

describe('waitForCapacity', () => {
  it('goes at once when the machine is calm', async () => {
    const r = await waitForCapacity({ limits: { maxLoadPerCpu: 1.5, minFreeMemMb: 300 }, sample: () => s(), sleep: async () => undefined });
    expect(r).toEqual({ waitedMs: 0, forced: false });
  });
  it('waits until the load drops, and says why once', async () => {
    let t = 0;
    const loads = [3, 3, 2.5, 0.4];
    const told: string[] = [];
    const r = await waitForCapacity({
      limits: { maxLoadPerCpu: 1.5, minFreeMemMb: 0 },
      sample: () => s({ loadPerCpu: loads.shift() ?? 0.4, load1: 2 }),
      sleep: async (ms) => void (t += ms),
      now: () => t,
      pollMs: 1000,
      onWait: (why) => told.push(why),
    });
    expect(r).toEqual({ waitedMs: 3000, forced: false });
    expect(told).toHaveLength(1);
  });
  it('never starves a task: it starts anyway after the maximum wait', async () => {
    let t = 0;
    const r = await waitForCapacity({ limits: { maxLoadPerCpu: 1, minFreeMemMb: 0 }, sample: () => s({ loadPerCpu: 5 }), sleep: async (ms) => void (t += ms), now: () => t, pollMs: 1000, maxWaitMs: 5000 });
    expect(r).toEqual({ waitedMs: 5000, forced: true });
  });
});

describe('CPU steal (a burstable instance out of credits)', () => {
  it('holds a start while the host takes too much CPU away', () => {
    const v = capacityVerdict(s({ stealPct: 35 }), { maxLoadPerCpu: 1.5, minFreeMemMb: 300, maxStealPct: 20 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('35%');
    expect(capacityVerdict(s({ stealPct: 35 }), { maxLoadPerCpu: 1.5, minFreeMemMb: 300, maxStealPct: 0 }).ok).toBe(true);
    expect(capacityVerdict(s({ stealPct: 35 }), { maxLoadPerCpu: 1.5, minFreeMemMb: 300 }).ok).toBe(true); // not given: no limit
  });
  it('reads steal from /proc/stat text and between two snapshots', () => {
    expect(parseCpuStat('cpu  100 0 50 800 20 0 5 25 0 0\ncpu0 1 2 3 4 5 6 7 8')).toEqual({ steal: 25, total: 1000 });
    expect(parseCpuStat('nothing')).toBeNull();
    expect(parseCpuStat('cpu 1 2 3')).toBeNull();
    expect(stealBetween({ steal: 25, total: 1000 }, { steal: 125, total: 1400 })).toBe(25);
    expect(stealBetween({ steal: 1, total: 10 }, { steal: 1, total: 10 })).toBe(0);
  });
});

describe('recommendConcurrency', () => {
  it('a 2-vCPU box runs one at a time, bigger boxes keep a core or two for the system', () => {
    expect(recommendConcurrency(2, 4096)).toBe(1);
    expect(recommendConcurrency(4, 16384)).toBe(3);
    expect(recommendConcurrency(8, 32768)).toBe(6);
  });
  it('memory caps it, and it is never below 1', () => {
    expect(recommendConcurrency(8, 4096)).toBe(2);
    expect(recommendConcurrency(8, 1024)).toBe(1);
    expect(recommendConcurrency(1, 512)).toBe(1);
  });
});

describe('StartThrottle', () => {
  it('lets one run at a time start, at least the gap apart', async () => {
    let t = 0;
    const starts: number[] = [];
    const th = new StartThrottle(() => t, async (ms) => void (t += ms));
    const gate = { limits: { maxLoadPerCpu: 0, minFreeMemMb: 0 }, sample: () => s(), gapMs: 10_000 };
    await Promise.all([1, 2, 3].map(() => th.enter(gate).then(() => starts.push(t))));
    expect(starts).toEqual([0, 10_000, 20_000]);
  });
  it('gap 0 does not delay', async () => {
    let t = 0;
    const th = new StartThrottle(() => t, async (ms) => void (t += ms));
    const gate = { limits: { maxLoadPerCpu: 0, minFreeMemMb: 0 }, sample: () => s(), gapMs: 0 };
    await th.enter(gate);
    await th.enter(gate);
    expect(t).toBe(0);
  });
  it('a failing waiter does not block the next one', async () => {
    const th = new StartThrottle(() => 0, async () => undefined);
    await expect(th.enter({ limits: { maxLoadPerCpu: 0, minFreeMemMb: 0 }, sample: () => { throw new Error('boom'); }, gapMs: 0 })).rejects.toThrow('boom');
    await expect(th.enter({ limits: { maxLoadPerCpu: 0, minFreeMemMb: 0 }, sample: () => s(), gapMs: 0 })).resolves.toMatchObject({ forced: false });
  });
});

describe('autoNodeHeapMb', () => {
  it('about a third of the memory on a small machine, within bounds; none on a big one', () => {
    expect(autoNodeHeapMb(4096)).toBe(1434); // t4g.medium
    expect(autoNodeHeapMb(1024)).toBe(768);
    expect(autoNodeHeapMb(11000)).toBe(3850);
    expect(autoNodeHeapMb(12288)).toBe(0);
  });
});

describe('memory', () => {
  const meminfo = 'MemTotal:        4015400 kB\nMemFree:          120000 kB\nMemAvailable:    1500000 kB\nSwapTotal:       2097148 kB\nSwapFree:        2000000 kB\n';
  it('reads /proc/meminfo, with swap; null without MemAvailable', () => {
    const m = parseMeminfo(meminfo)!;
    expect(Math.round(m.availableMb)).toBe(1465);
    expect(Math.round(m.totalMb)).toBe(3921);
    expect(Math.round(m.swapTotalMb)).toBe(2048);
    expect(parseMeminfo('MemTotal: 100 kB\n')).toBeNull();
    expect(parseMeminfo('')).toBeNull();
    expect(parseMeminfo('MemTotal: 4000000 kB\nMemAvailable: 1000 kB\n')!.swapTotalMb).toBe(0);
  });
  it('the newest run is stopped when memory runs out, nobody when it does not', () => {
    const runs = [{ taskId: 'old', startedAt: 1 }, { taskId: 'new', startedAt: 9 }, { taskId: 'mid', startedAt: 5 }];
    expect(oomVictim(runs, 150, 200)).toBe('new');
    expect(oomVictim(runs, 250, 200)).toBeNull();
    expect(oomVictim(runs, 10, 0)).toBeNull(); // guard off
    expect(oomVictim([], 10, 200)).toBeNull();
  });
  it('a memory shortage is held much longer than a busy CPU, never forced early', async () => {
    let t = 0;
    const r = await waitForCapacity({ limits: { maxLoadPerCpu: 0, minFreeMemMb: 300 }, sample: () => s({ freeMemMb: 100 }), sleep: async (ms) => void (t += ms), now: () => t, pollMs: 60_000, maxWaitMs: 10 * 60_000, maxMemoryWaitMs: 30 * 60_000 });
    expect(r).toEqual({ waitedMs: 30 * 60_000, forced: true });
    t = 0;
    const r2 = await waitForCapacity({ limits: { maxLoadPerCpu: 1, minFreeMemMb: 0 }, sample: () => s({ loadPerCpu: 5 }), sleep: async (ms) => void (t += ms), now: () => t, pollMs: 60_000, maxWaitMs: 10 * 60_000, maxMemoryWaitMs: 30 * 60_000 });
    expect(r2).toEqual({ waitedMs: 10 * 60_000, forced: true });
  });
});
