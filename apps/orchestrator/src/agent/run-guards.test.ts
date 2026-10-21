import { describe, expect, it } from 'vitest';
import { budgetExceeded, isIdleStuck, parseBudgetLimit, runExtension } from './run-guards';

const base = { now: 1_000_000, lastEventAt: 0, lastEventKind: 'assistant', approvalsPending: false, idleMs: 240_000 };

describe('isIdleStuck', () => {
  it('fires after the idle window', () => expect(isIdleStuck(base)).toBe(true));
  it('does not fire inside the window', () => expect(isIdleStuck({ ...base, lastEventAt: 900_000 })).toBe(false));
  it('is off with idleMs 0', () => expect(isIdleStuck({ ...base, idleMs: 0 })).toBe(false));
  it('waits for pending approvals', () => expect(isIdleStuck({ ...base, approvalsPending: true })).toBe(false));
  it('leaves a running tool to the overall timeout', () => expect(isIdleStuck({ ...base, lastEventKind: 'tool_use' })).toBe(false));
});

describe('budgets', () => {
  it('parses garbage and non-positive as disabled', () => {
    expect(parseBudgetLimit(undefined)).toBe(0);
    expect(parseBudgetLimit('abc')).toBe(0);
    expect(parseBudgetLimit('-5')).toBe(0);
    expect(parseBudgetLimit('1000')).toBe(1000);
  });
  it('is quiet when disabled or under the limit', () => {
    expect(budgetExceeded({ task: 1e9, day: 1e9 }, { perTask: 0, perDay: 0 })).toBeNull();
    expect(budgetExceeded({ task: 10, day: 10 }, { perTask: 100, perDay: 100 })).toBeNull();
  });
  it('names the limit that was hit', () => {
    expect(budgetExceeded({ task: 100, day: 0 }, { perTask: 100, perDay: 0 })).toMatch(/BUDGET_TOKENS_PER_TASK/);
    expect(budgetExceeded({ task: 0, day: 500 }, { perTask: 0, perDay: 100 })).toMatch(/BUDGET_TOKENS_PER_DAY/);
  });
});

describe('runExtension — a run that is still working is not cut off at the first window', () => {
  const MIN = 60_000;
  const s = { now: 10 * MIN, lastEventAt: 10 * MIN - 5_000, lastEventKind: 'assistant', grantedMs: 10 * MIN, baseMs: 10 * MIN, maxMs: 60 * MIN, graceMs: 90_000, toolGraceMs: 10 * MIN };
  it('grants half a window while output keeps coming', () => {
    expect(runExtension(s)).toBe(5 * MIN);
  });
  it('a run that went quiet is cut off', () => {
    expect(runExtension({ ...s, lastEventAt: s.now - 120_000 })).toBe(0);
  });
  it('a tool in flight counts as alive for a while, a hung one does not', () => {
    expect(runExtension({ ...s, lastEventKind: 'tool_use', lastEventAt: s.now - 5 * MIN })).toBe(5 * MIN);
    expect(runExtension({ ...s, lastEventKind: 'tool_use', lastEventAt: s.now - 11 * MIN })).toBe(0);
  });
  it('never beyond the absolute ceiling; the last grant is trimmed to it', () => {
    expect(runExtension({ ...s, grantedMs: 58 * MIN })).toBe(2 * MIN);
    expect(runExtension({ ...s, grantedMs: 60 * MIN })).toBe(0);
  });
  it('a ceiling not above the first window switches extension off', () => {
    expect(runExtension({ ...s, maxMs: 10 * MIN })).toBe(0);
    expect(runExtension({ ...s, maxMs: 0 })).toBe(0);
  });
});
