import { runAgent } from './run';
import { runCodex } from './codex';
import type { AgentEventHandler, AgentRunResult, RunAgentParams } from './types';

/**
 * An agent runtime: something that can run one headless agent turn for a task
 * and stream normalized events. `claude-code` is the Claude Agent SDK; `codex`
 * is the OpenAI Codex CLI. The orchestrator picks one per provider.
 */
export interface AgentRuntime {
  id: 'claude-code' | 'codex';
  run(params: RunAgentParams, onEvent: AgentEventHandler): Promise<AgentRunResult>;
}

export const claudeCodeRuntime: AgentRuntime = { id: 'claude-code', run: runAgent };
export const codexRuntime: AgentRuntime = { id: 'codex', run: runCodex };

/** Provider kind → runtime. Everything except `codex` runs on Claude Code (via LiteLLM when needed). */
export function runtimeForProviderKind(kind: string | undefined): AgentRuntime {
  return kind === 'codex' ? codexRuntime : claudeCodeRuntime;
}
