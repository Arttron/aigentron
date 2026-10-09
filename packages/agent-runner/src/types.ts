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

/** Options specific to the Codex runtime (provider kind `codex`). */
export interface CodexRunOptions {
  /**
   * Per-run CODEX_HOME: config.toml, hooks.json, AGENTS.md, auth.json and the
   * `sessions/` that make `exec resume` work. Must be stable per task (follow-ups
   * resume from it) and must NOT live under /tmp (Codex refuses helper binaries there).
   */
  home: string;
  /** Shared home holding the signed-in auth.json: copied into `home` before a run, synced back after (token refresh). */
  authHome: string;
  /** API key (authMode api-key) — exported as CODEX_API_KEY instead of using the ChatGPT login. */
  apiKey?: string;
  /** Codex binary (default `codex`). */
  bin?: string;
  /** Orchestrator-served HTTP MCP exposing the internal tools (report_task_status, …). */
  internalMcp?: { url: string; token: string };
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
  /** Codex runtime options; present only for provider kind `codex`. */
  codex?: CodexRunOptions;
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
  /** Fires for every raw message from the runtime (even ones we don't surface, e.g. model reasoning) — liveness for the watchdog. */
  onProgress?: () => void;
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
   * When set, the agent gets a `resources_search` tool over the project's shared library (notes, images, documents):
   * matching entries with the file path to Read. Wired for every agent.
   */
  onSearchResources?: (input: { query?: string; tag?: string }) => Promise<string>;
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
  /**
   * When set (admin agent only), the agent gets the catalog/agent-management
   * tools: `catalog_list`, `catalog_get`, `agents_list` (read-only) and
   * `propose_agent`, `propose_skill` (human-approved writes — gated in classify.ts).
   */
  admin?: AdminToolsWiring;
}

/** Callbacks behind the admin agent's tools; each resolves with text shown to the agent. */
export interface AdminToolsWiring {
  catalogList: () => Promise<string>;
  catalogGet: (name: string) => Promise<string>;
  agentsList: () => Promise<string>;
  /** Full file (frontmatter + prompt) of an existing agent — needed to edit it with propose_agent. */
  agentGet: (name: string) => Promise<string>;
  proposeAgent: (input: { name: string; content: string }) => Promise<{ ok: boolean; message: string }>;
  proposeSkill: (input: { name: string; content: string }) => Promise<{ ok: boolean; message: string }>;
  /** Platform tasks (read-only listing; no approval needed). */
  tasksList: (input: { status?: string; limit?: number; order?: string; olderThanDays?: number }) => Promise<string>;
  /** Cancel/delete explicit tasks — human-approved before anything happens. */
  proposeTaskAction: (input: { action: 'cancel' | 'delete'; taskIds: string[]; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Providers: read-only overview and connectivity check (never include secrets). */
  providersList: () => Promise<string>;
  providerTest: (name: string) => Promise<string>;
  /** Create/update a provider's configuration (no secret) and optionally make it default — human-approved. */
  proposeProvider: (input: {
    name: string;
    kind: string;
    model: string;
    authMode: string;
    baseUrl?: string;
    makeDefault?: boolean;
    reason: string;
  }) => Promise<{ ok: boolean; message: string }>;
  /** Recurring jobs: read-only listing, and create/change/delete — human-approved. */
  schedulesList: () => Promise<string>;
  proposeSchedule: (input: {
    action: 'create' | 'update' | 'delete';
    name: string;
    cron?: string;
    timezone?: string;
    kind?: 'message' | 'task';
    text?: string;
    agentName?: string;
    taskMode?: 'same' | 'new';
    channel?: string;
    chatId?: string;
    quietStart?: string;
    quietEnd?: string;
    enabled?: boolean;
    reason: string;
  }) => Promise<{ ok: boolean; message: string }>;
  /** Where the server answers: status is read-only; domains / Cloudflare Access changes are human-approved. */
  accessStatus: () => Promise<string>;
  proposeAllowedDomains: (input: { action: 'add' | 'remove' | 'set' | 'clear'; domains?: string[]; reason: string }) => Promise<{ ok: boolean; message: string }>;
  proposeCloudflareAccess: (input: { enabled: boolean; teamDomain: string; aud?: string; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Content packs: read-only overview, and install one — human-approved (never overwrites; schedules arrive switched off). */
  packsList: () => Promise<string>;
  proposePackInstall: (input: { name: string; timezone?: string; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Text notes in the project's resource library: create/update/delete — human-approved. (Reading/searching: the general resources_search tool.) */
  proposeResource: (input: {
    action: 'create' | 'update' | 'delete';
    id?: string;
    title?: string;
    description?: string;
    tags?: string[];
    agents?: string[];
    text?: string;
    reason: string;
  }) => Promise<{ ok: boolean; message: string }>;
  /** Chat channels: read-only overview (connectivity, allowed chats, chats waiting for approval) and create/change/delete — human-approved. */
  channelsList: () => Promise<string>;
  proposeChannel: (input: {
    action: 'create' | 'update' | 'delete';
    name: string;
    kind?: string;
    enabled?: boolean;
    defaultAgent?: string;
    allowChatId?: string;
    removeChatId?: string;
    reason: string;
  }) => Promise<{ ok: boolean; message: string }>;
  /** Several related changes behind one approval — human-approved as a whole. */
  proposeBatch: (input: { items: { kind: string; args: Record<string, unknown> }[]; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Start a task for another agent on the user's behalf — human-approved. */
  proposeTask: (input: { agentName: string; prompt: string; title?: string; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** The admin's own change journal (what it changed, which changes can be reverted). */
  adminHistory: (input: { limit?: number }) => Promise<string>;
  /** Change a few platform settings — human-approved, previous values are journaled for undo. */
  proposeSettings: (input: { changes: Record<string, unknown>; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Revert an earlier admin change from the journal — human-approved. */
  proposeUndo: (input: { changeId: string; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Why did a task end the way it did: status, error, agent/provider, reported summary, approvals, last messages. */
  taskDiagnose: (taskId: string) => Promise<string>;
  /** Token / request / cost usage per provider over the last N days. */
  usageReport: (input: { days?: number }) => Promise<string>;
  /** Ask the human to enter a secret in a secure field; resolves with whether it was saved (never the value). */
  requestSecret: (input: { target: 'provider' | 'github_token' | 'channel'; name?: string; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Disk-usage report of what runs leave behind (run folders, old worktrees, agent branches). */
  maintenanceReport: () => Promise<string>;
  /** Delete old run folders / worktrees (/ branches) — human-approved. */
  proposeCleanup: (input: { runs: boolean; worktrees: boolean; deleteBranches: boolean; olderThanDays?: number; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Delete an agent — human-approved. */
  proposeAgentDelete: (input: { name: string; reason: string }) => Promise<{ ok: boolean; message: string }>;
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
