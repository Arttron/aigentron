/**
 * How long and how far one agent run may go (Settings → Work → Run limits). The environment variables are the defaults;
 * what a person saves in the dashboard wins and applies from the next run, no restart.
 */
export interface RunLimits {
  /** First window of ACTIVE time (minutes); the clock stops while a person is asked something */
  timeoutMin: number;
  /** A run still making progress is extended while it works, up to this many minutes in all (not above timeoutMin = no extension) */
  maxMin: number;
  /** Seconds of silence after which a run no longer counts as "still working" */
  graceSec: number;
  /** Minutes without any output after which a run is stopped (0 = off) */
  idleMin: number;
  /** Steps (model turns) per run, the default for every agent that has none of its own */
  maxTurns: number;
  /** At the ceiling a person is asked whether the run may go on */
  askToExceed: boolean;
  /** …and how many more minutes an approval grants */
  extraMin: number;
}

const int = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};

/** A stored / posted object → valid limits; anything missing or out of range falls back to `defaults` or is clamped. */
export function normalizeRunLimits(raw: unknown, defaults: RunLimits): RunLimits {
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const timeoutMin = int(j.timeoutMin, 1, 240, defaults.timeoutMin);
  return {
    timeoutMin,
    // below the first window it means "no extension": keep it equal to it
    maxMin: Math.max(timeoutMin, int(j.maxMin, 0, 720, defaults.maxMin)),
    graceSec: int(j.graceSec, 10, 900, defaults.graceSec),
    idleMin: int(j.idleMin, 0, 120, defaults.idleMin),
    maxTurns: int(j.maxTurns, 5, 500, defaults.maxTurns),
    askToExceed: typeof j.askToExceed === 'boolean' ? j.askToExceed : defaults.askToExceed,
    extraMin: int(j.extraMin, 5, 480, defaults.extraMin),
  };
}

/** The limits implied by the environment (the numbers in milliseconds there). */
export function runLimitsFromEnv(c: { agentRunTimeoutMs: number; agentRunMaxMs: number; agentRunGraceMs: number; agentIdleTimeoutMs: number; agentMaxTurns: number }): RunLimits {
  return normalizeRunLimits(
    {
      timeoutMin: Math.round(c.agentRunTimeoutMs / 60_000),
      maxMin: Math.round(c.agentRunMaxMs / 60_000),
      graceSec: Math.round(c.agentRunGraceMs / 1000),
      idleMin: Math.round(c.agentIdleTimeoutMs / 60_000),
      maxTurns: c.agentMaxTurns,
    },
    { timeoutMin: 10, maxMin: 60, graceSec: 90, idleMin: 4, maxTurns: 40, askToExceed: true, extraMin: 30 },
  );
}
