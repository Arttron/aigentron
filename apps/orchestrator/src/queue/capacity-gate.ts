import { cpus, freemem, loadavg } from 'node:os';

/**
 * A small server (a 2-vCPU burstable instance) falls over when several agents compile, test and browse at once: the CPU credits run out, everything
 * slows, timeouts fire. The queue already limits how many runs are in flight; this limits how fast NEW ones start while the machine is busy:
 * a run waits (still `queued`) until the 1-minute load per CPU and the free memory are back inside the limits, but never longer than `maxWaitMs`
 * (it starts anyway then — a busy box must not starve a task for ever).
 */
export interface CapacitySample {
  /** 1-minute load average divided by the number of CPUs */
  loadPerCpu: number;
  load1: number;
  cpus: number;
  freeMemMb: number;
}

export interface CapacityLimits {
  /** 0 = no limit */
  maxLoadPerCpu: number;
  /** 0 = no limit */
  minFreeMemMb: number;
}

export const DEFAULT_LIMITS: CapacityLimits = { maxLoadPerCpu: 1.5, minFreeMemMb: 300 };

export interface CapacityVerdict {
  ok: boolean;
  /** why a start is held (null when ok) */
  reason: string | null;
}

/** Pure: may another run start now? */
export function capacityVerdict(s: CapacitySample, l: CapacityLimits): CapacityVerdict {
  if (l.maxLoadPerCpu > 0 && s.loadPerCpu > l.maxLoadPerCpu) {
    return { ok: false, reason: `the machine is busy (load ${s.load1.toFixed(1)} on ${s.cpus} CPU, limit ${(l.maxLoadPerCpu * s.cpus).toFixed(1)})` };
  }
  if (l.minFreeMemMb > 0 && s.freeMemMb < l.minFreeMemMb) {
    return { ok: false, reason: `little free memory (${Math.round(s.freeMemMb)} MB, at least ${l.minFreeMemMb} MB wanted)` };
  }
  return { ok: true, reason: null };
}

export function sampleSystem(): CapacitySample {
  const n = Math.max(1, cpus().length);
  const load1 = loadavg()[0] ?? 0;
  return { loadPerCpu: load1 / n, load1, cpus: n, freeMemMb: freemem() / 1_048_576 };
}

export interface GateOptions {
  limits: CapacityLimits;
  /** how often the machine is looked at while a run waits */
  pollMs?: number;
  /** the longest a run waits before it starts anyway */
  maxWaitMs?: number;
  sample?: () => CapacitySample;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWait?: (reason: string) => void;
}

export interface GateResult {
  /** milliseconds the run was held back */
  waitedMs: number;
  /** it started because the wait ran out, not because the machine calmed down */
  forced: boolean;
}

/** Hold a start while the machine is over its limits. Resolves when it may go (or after `maxWaitMs`). */
export async function waitForCapacity(o: GateOptions): Promise<GateResult> {
  const sample = o.sample ?? sampleSystem;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const poll = o.pollMs ?? 5_000;
  const max = o.maxWaitMs ?? 10 * 60_000;
  const started = now();
  let told = false;
  for (;;) {
    const v = capacityVerdict(sample(), o.limits);
    if (v.ok) return { waitedMs: now() - started, forced: false };
    if (now() - started >= max) return { waitedMs: now() - started, forced: true };
    if (!told) {
      told = true;
      o.onWait?.(v.reason ?? 'the machine is busy');
    }
    await sleep(poll);
  }
}
