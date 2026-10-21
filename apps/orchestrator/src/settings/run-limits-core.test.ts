import { describe, expect, it } from 'vitest';
import { normalizeRunLimits, runLimitsFromEnv, type RunLimits } from './run-limits-core';

const defaults: RunLimits = { timeoutMin: 10, maxMin: 60, graceSec: 90, idleMin: 4, maxTurns: 40, askToExceed: true, extraMin: 30 };

describe('run limits', () => {
  it('nothing given: the defaults', () => {
    expect(normalizeRunLimits(undefined, defaults)).toEqual(defaults);
    expect(normalizeRunLimits({}, defaults)).toEqual(defaults);
  });
  it('takes valid values, also as numeric strings', () => {
    expect(normalizeRunLimits({ timeoutMin: '20', maxMin: 90, graceSec: 60, idleMin: 0, maxTurns: 80, askToExceed: false, extraMin: 15 }, defaults)).toEqual({
      timeoutMin: 20,
      maxMin: 90,
      graceSec: 60,
      idleMin: 0,
      maxTurns: 80,
      askToExceed: false,
      extraMin: 15,
    });
  });
  it('clamps out-of-range values and ignores junk', () => {
    const r = normalizeRunLimits({ timeoutMin: 9999, maxMin: -5, graceSec: 1, idleMin: 'x', maxTurns: 1, extraMin: 0, askToExceed: 'yes' }, defaults);
    expect(r.timeoutMin).toBe(240);
    expect(r.graceSec).toBe(10);
    expect(r.idleMin).toBe(defaults.idleMin);
    expect(r.maxTurns).toBe(5);
    expect(r.extraMin).toBe(5);
    expect(r.askToExceed).toBe(true);
  });
  it('the ceiling is never below the first window (that means: no extension)', () => {
    expect(normalizeRunLimits({ timeoutMin: 30, maxMin: 10 }, defaults).maxMin).toBe(30);
    expect(normalizeRunLimits({ timeoutMin: 30, maxMin: 0 }, defaults).maxMin).toBe(30);
  });
  it('the environment gives the starting values', () => {
    expect(runLimitsFromEnv({ agentRunTimeoutMs: 600_000, agentRunMaxMs: 3_600_000, agentRunGraceMs: 90_000, agentIdleTimeoutMs: 240_000, agentMaxTurns: 40 })).toEqual(defaults);
    expect(runLimitsFromEnv({ agentRunTimeoutMs: 1_200_000, agentRunMaxMs: 0, agentRunGraceMs: 90_000, agentIdleTimeoutMs: 0, agentMaxTurns: 60 })).toMatchObject({ timeoutMin: 20, maxMin: 20, idleMin: 0, maxTurns: 60 });
  });
});
