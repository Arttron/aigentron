import type { AgentModelEnv } from '@lds/shared';

/** Context the PreToolUse approval hook needs, passed to the agent via env. */
export interface HookWiring {
  /** Absolute path to the Node hook script run on PreToolUse. */
  scriptPath: string;
  /** Orchestrator base URL the hook POSTs approval checks to. */
  approvalsUrl: string;
  /** Seconds the hook blocks for a verdict before failing closed (deny). */
  approvalTimeoutSeconds: number;
  /** Shared secret the hook sends to authenticate to the approvals API. */
  secret: string;
  taskId: string;
  agentSessionId: string;
  /** Absolute path to the compiled @lds/shared entry, so the hook can reuse the classifier. */
  sharedDistPath: string;
}

export interface RunAgentParams {
  prompt: string;
  /** Working directory the agent runs in — the worktree root, or a subdir of it. */
  cwd: string;
  /**
   * The task's isolated git worktree root — the write boundary enforced by the
   * classifier. Defaults to `cwd`; set it explicitly when `cwd` is a subdirectory
   * so the agent may still write anywhere within the worktree, not just the subdir.
   */
  workspaceRoot?: string;
  /** Resolved Anthropic env for the chosen provider (model/baseUrl/auth). */
  modelEnv: AgentModelEnv;
  /** Display labels for the transcript's "agent started" line. */
  providerLabel: string;
  modelLabel: string;
  maxTurns?: number;
  /** Claude session id to continue a previous conversation (--resume). */
  resumeSessionId?: string;
  /** Extra instructions appended to the Claude Code system prompt (the "skill"). */
  appendSystemPrompt?: string;
  /** Tool allow/deny lists for this run (e.g. a read-only reviewer). */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** MCP servers (Claude Agent SDK config) keyed by name. */
  mcpServers?: Record<string, Record<string, unknown>>;
  /**
   * Subagents the lead can delegate to via the Task tool, keyed by name. Each
   * carries its own system prompt, tool allow-list, and `model` (a LiteLLM
   * route `<provider>/<model>`, so the subagent runs on its own provider).
   */
  agents?: Record<string, SubagentDefinition>;
  abortController?: AbortController;
  /** Approval hook wiring. When omitted, no PreToolUse hook is configured. */
  hook?: HookWiring;
  /** Directory to write the generated settings.json into (defaults to <cwd>/.lds). */
  settingsDir?: string;
  /** Shared skills directory, exposed to the agent as $LDS_SKILLS_DIR. */
  skillsDir?: string;
  /** Per-task attachments directory, exposed as $LDS_ATTACHMENTS_DIR. */
  attachmentsDir?: string;
  /**
   * When set, the agent gets an in-process `report_task_status` tool and this is
   * invoked with the structured outcome the agent declares. The orchestrator
   * uses it as the authoritative terminal signal for the task.
   */
  onReportStatus?: (report: ReportedStatus) => void;
  /**
   * When set, the agent gets a lightweight `heartbeat` tool for long runs; this
   * fires each time it's called (feeds the no-progress watchdog / liveness).
   */
  onHeartbeat?: (beat: { progress?: string }) => void;
  /**
   * When set, the agent gets a `create_subtask` tool to decompose its task into
   * independent child tasks. Each call creates + enqueues a subtask and resolves
   * with the new task's id/title. Wire this only for lead agents.
   */
  onCreateSubtask?: (input: CreateSubtaskInput) => Promise<{ id: string; title: string }>;
  /**
   * When set, the agent gets a `check_subtasks` tool that returns the current
   * status + latest result of this task's subtasks (so a lead can see progress).
   */
  onCheckSubtasks?: () => Promise<{ id: string; title: string; status: string; summary: string }[]>;
  /**
   * When set, the agent gets a `schedule_check` tool to be re-run after a delay
   * ("check back in N seconds") — e.g. to poll CI. Resolves with the delay used.
   */
  onScheduleCheck?: (input: { delaySeconds: number; note?: string }) => Promise<{ delaySeconds: number }>;
  /**
   * When set, the agent gets a `preview_worktree` tool that starts (or reuses) an
   * ephemeral dev server for this task's worktree and returns its URL, so the
   * browser MCP can screenshot the agent's own changes rather than the base app.
   */
  onStartPreview?: () => Promise<{ url: string }>;
  /**
   * When set, the agent gets a `propose_learned_skill` tool (roadmap Phase 6) to
   * write/update agent/skills/learned/<name>.md — a durable, fleet-wide
   * observation worth surfacing to future runs. Unlike every other internal
   * tool this ONE requires human approval (see classify.ts); the call BLOCKS
   * until that resolves. Resolves with whether the write landed and a message
   * to show the agent (approved/denied/budget-exceeded reason).
   */
  onProposeLearnedSkill?: (input: { name: string; content: string }) => Promise<{ ok: boolean; message: string }>;
}

/** A subtask a lead agent asks to create via the `create_subtask` tool. */
export interface CreateSubtaskInput {
  title?: string;
  prompt: string;
  /** Specialist agent to run the subtask (e.g. backend); omit for the default. */
  agent?: string;
}

/** Structured outcome an agent declares via the `report_task_status` tool. */
export interface ReportedStatus {
  status: 'done' | 'failed' | 'blocked';
  /** Short human summary of what happened / what's left. */
  summary?: string;
  /** Files created or changed, for the human reviewing the result. */
  files?: string[];
  /** For `blocked`: what the agent needs from a human to continue. */
  handoff?: string;
}

/** One delegatable subagent (maps to the SDK's AgentDefinition). */
export interface SubagentDefinition {
  description: string;
  prompt: string;
  /** Model the subagent runs on (a LiteLLM route name), else inherits the lead. */
  model?: string;
  /** Tool allow-list; when omitted the subagent inherits the available tools. */
  tools?: string[];
}

/** Normalized event emitted for every meaningful step of an agent run. */
export type AgentEvent =
  | { kind: 'prompt'; text: string; attachments?: string[] }
  | { kind: 'system'; sessionId: string; model: string; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_use'; toolName: string; input: Record<string, unknown>; text: string }
  | { kind: 'delegation'; text: string }
  | {
      kind: 'tool_result';
      text: string;
      isError: boolean;
      /** Base64 images returned by the tool (e.g. an MCP browser screenshot). */
      images?: { data: string; mediaType: string }[];
    }
  | { kind: 'result'; isError: boolean; text: string; numTurns: number; costUsd: number }
  | { kind: 'stderr'; text: string };

/**
 * Token / request / cost usage for one agent run, read from the SDK result
 * message. Persisted per AgentSession for per-provider usage stats (roadmap
 * Phase 5). All counts default to 0 when the SDK reports none (e.g. an aborted
 * run that never produced a result message).
 */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Σ agentic turns the SDK ran (maps to a "request" in the stats view). */
  numTurns: number;
  /** SDK cost estimate — accurate for Anthropic, approximate/0 via LiteLLM. */
  costUsd: number;
  /** API duration in ms (SDK `duration_api_ms`). */
  apiMs: number;
}

export interface AgentRunResult {
  /** Claude session id captured from the init event (null if never seen). */
  sessionId: string | null;
  isError: boolean;
  /** Final result text (or error description). */
  result: string;
  /** True when the run ended by hitting maxTurns (subtype error_max_turns). */
  maxTurnsExceeded: boolean;
  /** Usage from the SDK result message (zeroed when none was reported). */
  usage: RunUsage;
}

export type AgentEventHandler = (event: AgentEvent) => void;
