/**
 * Pure run guards: the no-progress watchdog decision and the soft token budgets.
 * Kept free of Nest/Prisma so they are unit-testable.
 */

export interface IdleState {
  now: number;
  /** Time of the most recent agent event (any kind). */
  lastEventAt: number;
  /** Kind of that event — a pending `tool_use` means a tool is running and may legitimately be silent. */
  lastEventKind: string;
  /** The task is waiting for a human decision — silence is expected. */
  approvalsPending: boolean;
  /** 0 = watchdog off. */
  idleMs: number;
}

/** True when the run has produced nothing for too long and nobody is waiting on it. */
export function isIdleStuck(s: IdleState): boolean {
  if (s.idleMs <= 0 || s.approvalsPending) return false;
  // A running tool (long build, test suite) is covered by the overall run timeout instead.
  if (s.lastEventKind === 'tool_use') return false;
  return s.now - s.lastEventAt > s.idleMs;
}

export interface ExtensionState {
  now: number;
  lastEventAt: number;
  lastEventKind: string;
  /** active time granted so far (first window + extensions) */
  grantedMs: number;
  /** the first window (AGENT_RUN_TIMEOUT_MS) */
  baseMs: number;
  /** the absolute ceiling of active time (AGENT_RUN_MAX_MS); not above baseMs = no extension */
  maxMs: number;
  /** "still alive" = something was heard from the run this recently */
  graceMs: number;
  /** a tool call in flight (a long build / test run says nothing) counts as alive for this long */
  toolGraceMs: number;
}

/** Still working: something was heard from the run lately, or a tool call has been in flight for a reasonable time. */
export function runIsAlive(s: Pick<ExtensionState, 'now' | 'lastEventAt' | 'lastEventKind' | 'graceMs' | 'toolGraceMs'>): boolean {
  const quiet = s.now - s.lastEventAt;
  return quiet < s.graceMs || (s.lastEventKind === 'tool_use' && quiet < s.toolGraceMs);
}

/**
 * The run's time window ran out: how much more to grant (ms), 0 = let it expire. A run that is still producing output (or has a tool running
 * for a reasonable time) is not cut off in the middle of its work; one that went quiet, or reached the absolute ceiling, is.
 */
export function runExtension(s: ExtensionState): number {
  if (s.maxMs <= s.baseMs || s.grantedMs >= s.maxMs) return 0;
  if (!runIsAlive(s)) return 0;
  return Math.min(Math.max(60_000, Math.floor(s.baseMs / 2)), s.maxMs - s.grantedMs);
}

export interface BudgetLimits {
  perTask: number;
  perDay: number;
}

export function parseBudgetLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A human-readable reason the run must not start, or null. Limits of 0 are
 * disabled. `used` counts every billed token — input, output and cache
 * (X-COST-4); `day` is the current calendar day (server time).
 */
export function budgetExceeded(used: { task: number; day: number }, limits: BudgetLimits): string | null {
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (limits.perTask > 0 && used.task >= limits.perTask) {
    return `Token budget for this task is used up (${fmt(used.task)} of ${fmt(limits.perTask)} tokens incl. cache, BUDGET_TOKENS_PER_TASK). Raise the limit or continue in a new task.`;
  }
  if (limits.perDay > 0 && used.day >= limits.perDay) {
    return `Daily token budget is used up (${fmt(used.day)} of ${fmt(limits.perDay)} tokens incl. cache today, BUDGET_TOKENS_PER_DAY). Runs resume tomorrow, or raise the limit.`;
  }
  return null;
}
