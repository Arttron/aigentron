import { emptyUsage, type RunUsage, type SessionTotals } from '@lds/agent-runner';

/**
 * Pure usage accounting for one AgentSession row (X-COST-1/2/3/4).
 *
 * The Claude Agent SDK reports `total_cost_usd` and `modelUsage` as RUNNING
 * TOTALS of the whole Claude session: a resumed call continues from the total
 * its transcript saved. Every follow-up resumes, so storing the reported total
 * per session row double-counts the earlier spend (Stats grew ≈ quadratically
 * with the number of follow-ups). What a row must hold is the DELTA: the
 * session totals at the end of this run minus the totals already attributed to
 * earlier rows of the same Claude session (`baseline`).
 */

export function emptyTotals(): SessionTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
}

export function addTotals(a: SessionTotals, b: Partial<SessionTotals>): SessionTotals {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
    cacheCreationTokens: a.cacheCreationTokens + (b.cacheCreationTokens ?? 0),
    costUsd: a.costUsd + (b.costUsd ?? 0),
  };
}

/**
 * `total − baseline`, clamped at 0 per field. A negative delta can only come
 * from rows written before the delta accounting (they hold running totals, so
 * the baseline overstates what was spent); clamping under-counts such a
 * session once instead of going negative.
 */
export function subtractTotals(total: SessionTotals, baseline: Partial<SessionTotals>): SessionTotals {
  const d = (t: number, b: number | undefined) => Math.max(0, t - (b ?? 0));
  return {
    inputTokens: d(total.inputTokens, baseline.inputTokens),
    outputTokens: d(total.outputTokens, baseline.outputTokens),
    cacheReadTokens: d(total.cacheReadTokens, baseline.cacheReadTokens),
    cacheCreationTokens: d(total.cacheCreationTokens, baseline.cacheCreationTokens),
    costUsd: d(total.costUsd, baseline.costUsd),
  };
}

function hasAny(u: RunUsage): boolean {
  return u.inputTokens > 0 || u.outputTokens > 0 || u.cacheReadTokens > 0 || u.cacheCreationTokens > 0 || u.costUsd > 0 || u.numTurns > 0;
}

/**
 * The usage to attribute to a run.
 *  - A Claude run that reached its result message carries `sessionTotals`
 *    (modelUsage: subagents included); the row gets `totals − baseline`.
 *  - A Codex run reports per-turn sums (nothing restored across resumes):
 *    its `usage` is already the delta.
 *  - A run that never got a result (abort, timeout, transport error) falls
 *    back to the per-step usage collected from the assistant messages
 *    (`partial`: input + cache tokens of the main loop; output tokens and cost
 *    are not recoverable that way) — before this, such runs wrote 0.
 */
export function accountRunUsage(
  result: { usage: RunUsage; sessionTotals?: SessionTotals },
  baseline: Partial<SessionTotals>,
  partial: SessionTotals,
): RunUsage {
  if (result.sessionTotals) {
    return { ...subtractTotals(result.sessionTotals, baseline), numTurns: result.usage.numTurns, apiMs: result.usage.apiMs };
  }
  if (hasAny(result.usage)) return result.usage;
  return { ...emptyUsage(), ...partial, costUsd: 0 };
}

/**
 * The reporting-resume continues the SAME session: its totals already include
 * the main run, so its own share is `resumeTotals − mainTotals`. Without
 * session totals on either side (Codex), its per-turn usage is the share.
 */
export function reportingResumeUsage(
  main: { sessionTotals?: SessionTotals },
  resume: { usage: RunUsage; sessionTotals?: SessionTotals },
): RunUsage {
  if (resume.sessionTotals && main.sessionTotals) {
    return { ...subtractTotals(resume.sessionTotals, main.sessionTotals), numTurns: resume.usage.numTurns, apiMs: resume.usage.apiMs };
  }
  return resume.usage;
}

/** Cumulative totals a run's session had reached (for the next run's baseline / the resume's share). */
export function totalsAfter(baseline: Partial<SessionTotals>, stored: RunUsage): SessionTotals {
  return addTotals(addTotals(emptyTotals(), baseline), pick(stored));
}

function pick(u: RunUsage): SessionTotals {
  return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheCreationTokens: u.cacheCreationTokens, costUsd: u.costUsd };
}

/**
 * Tokens that count against the soft budgets (X-COST-4): everything the
 * provider bills — input, output AND cache (read + creation). Cache tokens used
 * to be left out, which made the limits far looser than their numbers said.
 */
export function budgetTokens(sum: { inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null }): number {
  return (sum.inputTokens ?? 0) + (sum.outputTokens ?? 0) + (sum.cacheReadTokens ?? 0) + (sum.cacheCreationTokens ?? 0);
}

/** Local midnight: the daily budget is per calendar day (server time), not a rolling 24 h. */
export function startOfLocalDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}
