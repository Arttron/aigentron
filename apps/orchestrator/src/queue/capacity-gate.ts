import { readFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';

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
  /**
   * Share of CPU time the hypervisor took away from this machine over the last few seconds (0-100; 0 when unknown / not Linux). A burstable
   * instance whose CPU credits ran out shows it here long before the load average does.
   */
  stealPct: number;
}

export interface CapacityLimits {
  /** 0 = no limit */
  maxLoadPerCpu: number;
  /** 0 = no limit */
  minFreeMemMb: number;
  /** 0 = no limit */
  maxStealPct?: number;
}

export const DEFAULT_LIMITS: CapacityLimits = { maxLoadPerCpu: 1.5, minFreeMemMb: 300, maxStealPct: 20 };

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
  if ((l.maxStealPct ?? 0) > 0 && s.stealPct > (l.maxStealPct ?? 0)) {
    return { ok: false, reason: `the host is taking CPU away (${Math.round(s.stealPct)}% stolen, limit ${l.maxStealPct}% — a burstable instance out of CPU credits)` };
  }
  return { ok: true, reason: null };
}

/** `cpu  user nice system idle iowait irq softirq steal …` of /proc/stat → [steal, total] jiffies (null when not Linux / unreadable). Pure given the text. */
export function parseCpuStat(text: string): { steal: number; total: number } | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  if (f.length < 8 || f.some((x) => !Number.isFinite(x))) return null;
  // guest time is already inside user / nice: the first eight fields are the whole of it
  return { steal: f[7]!, total: f.slice(0, 8).reduce((a, b) => a + b, 0) };
}

/** Steal share between two snapshots, 0-100. */
export function stealBetween(a: { steal: number; total: number }, b: { steal: number; total: number }): number {
  const dt = b.total - a.total;
  return dt > 0 ? Math.max(0, Math.min(100, ((b.steal - a.steal) / dt) * 100)) : 0;
}

let lastStat: { at: number; snap: { steal: number; total: number } } | null = null;
let lastSteal = 0;

/** Steal over the interval since the previous call (kept for at least 2 s so two quick callers see the same figure). */
function currentStealPct(): number {
  let snap: { steal: number; total: number } | null = null;
  try {
    snap = parseCpuStat(readFileSync('/proc/stat', 'utf8'));
  } catch {
    return 0;
  }
  if (!snap) return 0;
  const now = Date.now();
  if (lastStat && now - lastStat.at < 2000) return lastSteal;
  if (lastStat) lastSteal = stealBetween(lastStat.snap, snap);
  lastStat = { at: now, snap };
  return lastSteal;
}

export function sampleSystem(): CapacitySample {
  const n = Math.max(1, cpus().length);
  const load1 = loadavg()[0] ?? 0;
  return { loadPerCpu: load1 / n, load1, cpus: n, freeMemMb: freemem() / 1_048_576, stealPct: currentStealPct() };
}

/**
 * How many agent runs this machine can carry at once: one less than the CPUs on a small box (2 vCPU -> 1) so the dashboard and SSH keep a core,
 * at most the CPUs on a bigger one, and no more than ~1.5 GB of memory per run beyond the 1 GB the system itself needs. Never below 1.
 */
export function recommendConcurrency(cpuCount: number, totalMemMb: number): number {
  const byCpu = cpuCount <= 2 ? 1 : cpuCount <= 4 ? cpuCount - 1 : cpuCount - 2;
  const byMem = Math.floor((totalMemMb / 1024 - 1) / 1.5);
  return Math.max(1, Math.min(byCpu, byMem));
}

/**
 * A heap cap (MB) for the Node processes an agent starts (tsc, vitest, builds): on a small machine one runaway build must fail with "heap out of
 * memory" instead of taking all the memory — and the dashboard with it. About a third of the RAM, between 768 MB and 4 GB; none (0) on a big
 * machine (12 GB and more), where it would only get in the way.
 */
export function autoNodeHeapMb(totalMemMb: number): number {
  if (totalMemMb >= 12 * 1024) return 0;
  return Math.max(768, Math.min(4096, Math.round(totalMemMb * 0.35)));
}

export const machineConcurrency = (): number => recommendConcurrency(Math.max(1, cpus().length), totalmem() / 1_048_576);

/**
 * Starts go through here one at a time, at least `gapMs` apart. The load average lags by a minute, so without a gap two held runs see
 * "calm" together, both start, and the machine is over its limit again before either shows up in the figures.
 */
export class StartThrottle {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStartAt: number | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Wait for my turn and for the gap, then for the machine; resolves when this run may start. */
  enter(gate: GateOptions & { gapMs: number }): Promise<GateResult> {
    const run = this.chain.then(async () => {
      const t0 = this.now();
      const since = this.lastStartAt === null ? Infinity : this.now() - this.lastStartAt;
      if (gate.gapMs > 0 && since < gate.gapMs) await this.sleep(gate.gapMs - since);
      const r = await waitForCapacity({ ...gate, sleep: gate.sleep ?? this.sleep, now: gate.now ?? this.now });
      this.lastStartAt = this.now();
      return { ...r, waitedMs: this.lastStartAt - t0 };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
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

export const machineNodeHeapMb = (): number => autoNodeHeapMb(totalmem() / 1_048_576);
