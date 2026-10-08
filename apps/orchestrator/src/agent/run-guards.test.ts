import { describe, expect, it } from 'vitest';
import { budgetExceeded, isIdleStuck, parseBudgetLimit } from './run-guards';

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
