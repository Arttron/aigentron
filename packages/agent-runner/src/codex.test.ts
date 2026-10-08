import { describe, expect, it } from 'vitest';
import { mapCodexEvent } from './codex';

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
