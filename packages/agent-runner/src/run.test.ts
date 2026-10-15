import { describe, expect, it } from 'vitest';
import { sessionTotalsOf } from './run';
import { emptyUsage } from './usage';

describe('sessionTotalsOf', () => {
  it('sums modelUsage over models (subagents included) and takes total_cost_usd', () => {
    const t = sessionTotalsOf(
      {
        total_cost_usd: 1.25,
        modelUsage: {
          'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 1000, cacheCreationInputTokens: 50, costUSD: 1 },
          'claude-haiku-4-5': { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.25 },
        },
      },
      { ...emptyUsage(), inputTokens: 100 },
    );
    expect(t).toEqual({ inputTokens: 120, outputTokens: 15, cacheReadTokens: 1000, cacheCreationTokens: 50, costUsd: 1.25 });
  });
  it('falls back to the main-loop usage when modelUsage is absent', () => {
    const t = sessionTotalsOf({ total_cost_usd: 0.5 }, { ...emptyUsage(), inputTokens: 7, cacheReadTokens: 3 });
    expect(t).toEqual({ inputTokens: 7, outputTokens: 0, cacheReadTokens: 3, cacheCreationTokens: 0, costUsd: 0.5 });
  });
  it('treats null/NaN cost as 0', () => {
    expect(sessionTotalsOf({ total_cost_usd: Number.NaN }, emptyUsage()).costUsd).toBe(0);
  });
});
