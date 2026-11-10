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

import { mcpNotConnected } from './run';

describe('mcpNotConnected', () => {
  it('says which servers did not connect and what that means', () => {
    const w = mcpNotConnected([{ name: 'playwright', status: 'failed' }, { name: 'research', status: 'connected' }, { name: 'github', status: 'pending' }]);
    expect(w).toContain('"playwright" (failed)');
    expect(w).toContain('"github" (pending)');
    expect(w).not.toContain('research');
    expect(w).toContain('not available');
  });
  it('nothing when all are connected, or none were reported', () => {
    expect(mcpNotConnected([{ name: 'a', status: 'connected' }])).toBeNull();
    expect(mcpNotConnected(undefined)).toBeNull();
    expect(mcpNotConnected([{ name: 'a' }])).toBeNull();
  });
});

import { mcpToolSummary } from './run';

describe('mcpToolSummary', () => {
  it('counts the tools of each given tool server', () => {
    const tools = ['Read', 'Bash', 'mcp__playwright__browser_navigate', 'mcp__playwright__browser_snapshot', 'mcp__browser-ext__browser_open', 'mcp__lds_internal__report_task_status'];
    expect(mcpToolSummary(tools, ['playwright', 'browser-ext', 'lds_internal'])).toBe('ℹ MCP tools in this run — playwright: 2, browser-ext: 1.');
  });
  it('warns about a given server that has no tools', () => {
    const s = mcpToolSummary(['mcp__browser-ext__browser_open'], ['playwright', 'browser-ext'])!;
    expect(s).toContain('playwright: 0');
    expect(s).toContain('No tools from "playwright"');
  });
  it('nothing when no tool server was given', () => {
    expect(mcpToolSummary(['Read'], [])).toBeNull();
    expect(mcpToolSummary([], ['lds_internal'])).toBeNull();
  });
  it('server names with a dash or a single underscore are read whole', () => {
    expect(mcpToolSummary(['mcp__my_server__do_thing'], ['my_server'])).toBe('ℹ MCP tools in this run — my_server: 1.');
  });
});
