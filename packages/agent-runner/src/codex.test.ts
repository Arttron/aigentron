import { describe, expect, it } from 'vitest';
import { mapCodexEvent, renderCodexConfig, streamableOf } from './codex';
import type { RunAgentParams } from './types';

describe('mapCodexEvent', () => {
  it('maps a finished agent message and ignores a started one', () => {
    expect(mapCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } })).toEqual([{ kind: 'assistant', text: 'hi' }]);
    expect(mapCodexEvent({ type: 'item.started', item: { type: 'agent_message', text: 'hi' } })).toEqual([]);
  });
  it('maps commands to Bash tool_use / tool_result with exit code', () => {
    const [use] = mapCodexEvent({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } });
    expect(use).toMatchObject({ kind: 'tool_use', toolName: 'Bash', input: { command: 'ls' } });
    const [res] = mapCodexEvent({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x', exit_code: 2 } });
    expect(res).toMatchObject({ kind: 'tool_result', isError: true });
  });
  it('names MCP tools like Claude does', () => {
    const [use] = mapCodexEvent({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'lds_internal', tool: 'heartbeat', arguments: {} } });
    expect(use).toMatchObject({ toolName: 'mcp__lds_internal__heartbeat' });
  });
  it('swallows the hook-trust bypass noise and unknown items', () => {
    expect(mapCodexEvent({ type: 'item.completed', item: { type: 'error', message: 'x --dangerously-bypass-hook-trust y' } })).toEqual([]);
    expect(mapCodexEvent({ type: 'item.completed', item: { type: 'reasoning' } })).toEqual([]);
    expect(mapCodexEvent({ type: 'turn.completed' })).toEqual([]);
  });
});

describe('an SSE tool server for a Codex agent', () => {
  const params = (servers: Record<string, unknown>) => ({ mcpServers: servers }) as unknown as RunAgentParams;

  it('the SSE address of a server is turned into its streamable HTTP twin (…/sse → …/mcp)', () => {
    expect(streamableOf('http://127.0.0.1:8931/sse')).toBe('http://127.0.0.1:8931/mcp');
    expect(streamableOf('http://playwright-mcp:8931/sse/')).toBe('http://playwright-mcp:8931/mcp');
    expect(streamableOf('http://h:1/base/sse')).toBe('http://h:1/base/mcp');
    expect(streamableOf('http://h:1/events')).toBeNull();
    expect(streamableOf('not a url')).toBeNull();
  });

  it('the Playwright server reaches Codex as a streamable HTTP server instead of being skipped', () => {
    const warnings: string[] = [];
    const orig = { type: 'sse', url: 'http://127.0.0.1:8931/sse' };
    const toml = renderCodexConfig(params({ playwright: orig }), undefined, (m) => warnings.push(m));
    expect(toml).toContain('[mcp_servers."playwright"]');
    expect(toml).toContain('url = "http://127.0.0.1:8931/mcp"');
    expect(warnings.join('\n')).toContain('streamable HTTP address');
    expect(orig.url).toBe('http://127.0.0.1:8931/sse'); // the caller's config is not changed
  });

  it('an SSE server that does not look like …/sse is still skipped, with the reason', () => {
    const warnings: string[] = [];
    const toml = renderCodexConfig(params({ odd: { type: 'sse', url: 'http://h:1/stream' } }), undefined, (m) => warnings.push(m));
    expect(toml).not.toContain('odd');
    expect(warnings.join('\n')).toContain('does not support');
  });
});
