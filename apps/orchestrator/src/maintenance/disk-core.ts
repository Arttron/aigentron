/** Disk space — pure helpers (unit-tested). */

export type DiskLevel = 'ok' | 'warn' | 'critical';

export interface DiskThresholds {
  /** warn below this share of free space (percent) or this many free bytes — whichever trips first */
  warnPercent: number;
  warnBytes: number;
  criticalPercent: number;
  criticalBytes: number;
}

export const GB = 1024 ** 3;
export const DEFAULT_THRESHOLDS: DiskThresholds = { warnPercent: 15, warnBytes: 3 * GB, criticalPercent: 7, criticalBytes: 1 * GB };

/** A percentage means little on a big disk (7 % of 2 TB is 140 GB): the percentage-based limit is capped. */
const WARN_CAP = 20 * GB;
const CRITICAL_CAP = 8 * GB;

/** The free space (bytes) below which a disk is `warn` / `critical`: the percentage share, capped on big disks, but never under the absolute floor. */
export function limits(total: number, t: DiskThresholds = DEFAULT_THRESHOLDS): { warnAt: number; criticalAt: number } {
  return {
    warnAt: Math.max(t.warnBytes, Math.min((total * t.warnPercent) / 100, WARN_CAP)),
    criticalAt: Math.max(t.criticalBytes, Math.min((total * t.criticalPercent) / 100, CRITICAL_CAP)),
  };
}

export function diskLevel(free: number, total: number, t: DiskThresholds = DEFAULT_THRESHOLDS): DiskLevel {
  if (!(total > 0)) return 'ok'; // nothing to judge (a filesystem that reports no size)
  const { warnAt, criticalAt } = limits(total, t);
  if (free < criticalAt) return 'critical';
  if (free < warnAt) return 'warn';
  return 'ok';
}

export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

/** Thresholds from env (DISK_WARN_PERCENT, DISK_WARN_GB, DISK_CRITICAL_PERCENT, DISK_CRITICAL_GB); bad values fall back to the defaults. */
export function thresholdsFromEnv(env: Record<string, string | undefined>): DiskThresholds {
  const num = (k: string, def: number, scale = 1): number => {
    const v = Number(env[k]);
    return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) && v >= 0 ? v * scale : def * scale;
  };
  const t = {
    warnPercent: num('DISK_WARN_PERCENT', DEFAULT_THRESHOLDS.warnPercent),
    warnBytes: num('DISK_WARN_GB', DEFAULT_THRESHOLDS.warnBytes / GB, GB),
    criticalPercent: num('DISK_CRITICAL_PERCENT', DEFAULT_THRESHOLDS.criticalPercent),
    criticalBytes: num('DISK_CRITICAL_GB', DEFAULT_THRESHOLDS.criticalBytes / GB, GB),
  };
  // critical must not be looser than warn
  return { ...t, criticalPercent: Math.min(t.criticalPercent, t.warnPercent), criticalBytes: Math.min(t.criticalBytes, t.warnBytes) };
}

/**
 * Whether to tell the operators now: when the level gets worse, and again at most every `repeatMs` while it stays bad.
 * (Getting better is silent — the banner just disappears.)
 */
export function shouldNotify(prev: DiskLevel, now: DiskLevel, lastNotifiedAt: number | null, at: number, repeatMs = 12 * 3_600_000): boolean {
  if (now === 'ok') return false;
  const rank = { ok: 0, warn: 1, critical: 2 } as const;
  if (rank[now] > rank[prev]) return true;
  return lastNotifiedAt === null || at - lastNotifiedAt >= repeatMs;
}
