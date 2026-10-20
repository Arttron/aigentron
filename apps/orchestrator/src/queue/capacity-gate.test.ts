import { describe, expect, it } from 'vitest';
import { capacityVerdict, waitForCapacity, type CapacitySample } from './capacity-gate';

const s = (over: Partial<CapacitySample> = {}): CapacitySample => ({ loadPerCpu: 0.5, load1: 1, cpus: 2, freeMemMb: 2000, ...over });

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
