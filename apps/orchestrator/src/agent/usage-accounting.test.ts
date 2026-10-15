import { describe, expect, it } from 'vitest';
import type { RunUsage, SessionTotals } from '@lds/agent-runner';
import { accountRunUsage, budgetTokens, emptyTotals, reportingResumeUsage, startOfLocalDay, subtractTotals, totalsAfter } from './usage-accounting';

const totals = (p: Partial<SessionTotals>): SessionTotals => ({ ...emptyTotals(), ...p });
const usage = (p: Partial<RunUsage>): RunUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0, costUsd: 0, apiMs: 0, ...p });

describe('subtractTotals', () => {
  it('subtracts per field and clamps at zero', () => {
    expect(subtractTotals(totals({ costUsd: 2.5, inputTokens: 100 }), { costUsd: 1, inputTokens: 150 })).toMatchObject({ costUsd: 1.5, inputTokens: 0 });
    expect(subtractTotals(totals({ costUsd: 1 }), {})).toMatchObject({ costUsd: 1 });
  });
});

describe('accountRunUsage (X-COST-1/2/3)', () => {
  it('a first run stores the session totals as they are (baseline 0)', () => {
    const r = accountRunUsage({ usage: usage({ inputTokens: 10, numTurns: 3, apiMs: 500 }), sessionTotals: totals({ inputTokens: 40, outputTokens: 5, costUsd: 0.2 }) }, {}, emptyTotals());
    // tokens come from modelUsage (subagents included), not the main-loop `usage`
    expect(r).toEqual(usage({ inputTokens: 40, outputTokens: 5, costUsd: 0.2, numTurns: 3, apiMs: 500 }));
  });
  it('a follow-up stores the DELTA, not the cumulative total of the session', () => {
    const r = accountRunUsage({ usage: usage({ numTurns: 2 }), sessionTotals: totals({ inputTokens: 100, costUsd: 3 }) }, { inputTokens: 60, costUsd: 2 }, emptyTotals());
    expect(r).toMatchObject({ inputTokens: 40, costUsd: 1, numTurns: 2 });
  });
  it('a Codex run (per-turn sums, no session totals) is stored as reported', () => {
    const u = usage({ inputTokens: 7, outputTokens: 3, numTurns: 1 });
    expect(accountRunUsage({ usage: u }, { inputTokens: 999 }, emptyTotals())).toEqual(u);
  });
  it('a run without a result falls back to the per-step partial usage (cost unknown → 0)', () => {
    const r = accountRunUsage({ usage: usage({}) }, {}, totals({ inputTokens: 12, cacheReadTokens: 300, costUsd: 9 }));
    expect(r).toEqual(usage({ inputTokens: 12, cacheReadTokens: 300, costUsd: 0 }));
  });
});

describe('reportingResumeUsage', () => {
  it("is the resume's share of the session totals", () => {
    const r = reportingResumeUsage({ sessionTotals: totals({ costUsd: 1, inputTokens: 50 }) }, { usage: usage({ numTurns: 1 }), sessionTotals: totals({ costUsd: 1.3, inputTokens: 70 }) });
    expect(r).toMatchObject({ inputTokens: 20, numTurns: 1 });
    expect(r.costUsd).toBeCloseTo(0.3, 10);
  });
  it('is the reported usage when there are no session totals (Codex)', () => {
    const u = usage({ inputTokens: 5 });
    expect(reportingResumeUsage({}, { usage: u })).toEqual(u);
  });
});

describe('totalsAfter / budgetTokens / startOfLocalDay', () => {
  it('totalsAfter = baseline + what the row stored', () => {
    expect(totalsAfter({ costUsd: 1 }, usage({ costUsd: 0.5, inputTokens: 3 }))).toMatchObject({ costUsd: 1.5, inputTokens: 3 });
  });
  it('budget counts cache tokens too (X-COST-4)', () => {
    expect(budgetTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 30, cacheCreationTokens: 400 })).toBe(433);
    expect(budgetTokens({ inputTokens: null, outputTokens: undefined })).toBe(0);
  });
  it('startOfLocalDay is local midnight', () => {
    const d = startOfLocalDay(new Date(2026, 9, 15, 13, 45));
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 15, 0, 0]);
  });
});
