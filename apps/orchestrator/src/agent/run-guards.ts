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

export interface BudgetLimits {
  perTask: number;
  perDay: number;
}

export function parseBudgetLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A human-readable reason the run must not start, or null. Limits of 0 are disabled. */
export function budgetExceeded(used: { task: number; day: number }, limits: BudgetLimits): string | null {
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (limits.perTask > 0 && used.task >= limits.perTask) {
    return `Token budget for this task is used up (${fmt(used.task)} of ${fmt(limits.perTask)} tokens, BUDGET_TOKENS_PER_TASK). Raise the limit or continue in a new task.`;
  }
  if (limits.perDay > 0 && used.day >= limits.perDay) {
    return `Daily token budget is used up (${fmt(used.day)} of ${fmt(limits.perDay)} tokens in the last 24 hours, BUDGET_TOKENS_PER_DAY). Runs resume as older usage ages out, or raise the limit.`;
  }
  return null;
}
