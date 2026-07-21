import type { RunUsage } from './types';

/** A zeroed usage record — the starting point before a result is read/accumulated. */
export function emptyUsage(): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    numTurns: 0,
    costUsd: 0,
    apiMs: 0,
  };
}

/**
 * Field-wise sum of two usage records. Used to attribute BOTH the main run and
 * the follow-up reporting-resume (a second SDK call on the same session) to one
 * AgentSession — otherwise the reporting turn's tokens/cost go uncounted.
 */
export function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    numTurns: a.numTurns + b.numTurns,
    costUsd: a.costUsd + b.costUsd,
    apiMs: a.apiMs + b.apiMs,
  };
}
