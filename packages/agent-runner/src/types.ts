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

/**
 * Run the agent process as a separate, unprivileged OS user (S-01). The runtime
 * binary (Claude CLI / Codex) is started through `wrapper` (infra/agent-exec.sh),
 * which drops to `uid`/`gid` with `setpriv` before exec-ing the real binary; the
 * agent's HOME/TMPDIR move to `home` (a directory the caller created and chowned
 * to `uid`). When the wrapper or setpriv is missing the run FAILS — never a
 * silent fallback to the orchestrator's own user.
 */
export interface AgentIsolation {
  uid: number;
  gid: number;
  /** Absolute path to the executable wrapper script. */
  wrapper: string;
  /** Writable HOME for the agent process, owned by `uid` (e.g. <runs>/<task>/home). */
  home: string;
}

export interface RunAgentParams {
  prompt: string;
  /** Run the agent binary as a separate OS user; omitted = the orchestrator's own user (today's behaviour). */
  isolation?: AgentIsolation;
  /** CPU niceness for the agent process (1-19; 0 / omitted = unchanged) — the machine keeps answering when agents hog the CPU. */
  niceness?: number;
  /** Heap cap (MB) for the Node processes the agent starts, via NODE_OPTIONS (0 / omitted = none). */
  nodeMaxMb?: number;
  /** Working directory the agent runs in — the worktree root, or a subdir of it. */
  cwd: string;
  /**
   * The task's isolated git worktree root — the write boundary enforced by the
   * classifier. Defaults to `cwd`; set it explicitly when `cwd` is a subdirectory
   * so the agent may still write anywhere within the worktree, not just the subdir.
   */
  workspaceRoot?: string;
  /** More folders the agent may write to besides `workspaceRoot` (the shared workspace). */
  extraWriteRoots?: string[];
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
   * Per-step usage as it happens (each API response once; main loop only; input +
   * cache tokens — the per-step output count is a placeholder). The caller sums
   * these to attribute SOMETHING to a run that never reaches its result message
   * (abort, timeout, transport error) instead of 0 (X-COST-3).
   */
  onPartialUsage?: (step: Pick<SessionTotals, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>) => void;
  /**
   * When set, the agent gets a `create_subtask` tool to decompose its task into
   * independent child tasks. Each call creates + enqueues a subtask and resolves
   * with the new task's id/title. Wire this only for lead agents.
   */
  onCreateSubtask?: (input: CreateSubtaskInput) => Promise<{ id: string; title: string; /** an equivalent open subtask already existed: nothing new was created */ reused?: boolean }>;
  /**
   * When set (a code project with a remote), the agent gets a `push_branch` tool: publish a LOCAL branch to the project's remote through
   * the orchestrator (the agent holds no credentials; a person approves each push). Resolves with a message for the model.
   */
  onPushBranch?: (input: { branch: string; to?: string; reason?: string }) => Promise<string>;
  /**
   * When set (a code project with a remote), the agent gets a `fetch_remote` tool: update the remote-tracking branches (`origin/<branch>`) with the project's
   * credentials, which the agent's own shell does not have. No approval: it only downloads. Resolves with a message for the model.
   */
  onFetchRemote?: (input: { branch?: string }) => Promise<string>;
  /**
   * When set (the agent's file says `createTasks: true`), the agent gets a `create_task` tool: start a NEW top-level task in a project.
   * Resolves with a message for the model (created / reused / refused).
   */
  onCreateTask?: (input: { project: string; prompt: string; title?: string; agent?: string; reason?: string; related?: string[] }) => Promise<string>;
  /**
   * When set, the agent gets a `check_subtasks` tool that returns the current
   * status + latest result of this task's subtasks (so a lead can see progress).
   */
  /** Mark one of this task's subtasks done (it must have finished its run). Resolves with a message for the model. */
  onCompleteSubtask?: (id: string) => Promise<string>;
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
  /** `look_at`: a vision model answers a question about a photo or a video's frames (path = a file from attachments / resources / the workspace). */
  /** Ask the human a question (answer buttons in the dashboard / channels) and wait; resolves with the answer text for the model. */
  /** The current date/time (optionally in an IANA timezone) as text for the model. */
  onCurrentTime?: (input: { timezone?: string }) => string;
  /** Knowledge bases (the orchestrator answers; agents never see credentials or other bases). */
  kb?: {
    list: () => Promise<string>;
    search: (input: { query: string; kb?: string; limit?: number }) => Promise<string>;
    read: (input: { doc: string; chunk?: number }) => Promise<string>;
    add?: (input: { kb: string; title: string; text: string; source?: string }) => Promise<string>;
  };
  /** The shared workspace tools: `info`/`files` always, `note`/`save` unless the agent may only read it. */
  workspace?: {
    info: () => Promise<string>;
    files: (input: { dir?: string; glob?: string; limit?: number }) => Promise<string>;
    note?: (input: { kind: string; text: string; resolves?: string }) => Promise<string>;
    save?: (input: { path: string; content?: string; from?: string; note?: string }) => Promise<string>;
  };
  /** `read_document`: the text of an attachment / workspace / library file, for agents that have no file reader (the admin). */
  onReadDocument?: (input: { path: string; from?: number }) => Promise<string>;
  /** Show pictures in the chat (single or an album); resolves with the text the model reads. */
  onShowImages?: (input: { paths: string[]; caption?: string }) => Promise<string>;
  onAskUser?: (input: { question: string; options: string[]; allowText: boolean; multiple?: boolean; image?: string }) => Promise<string>;
  onLookAt?: (input: { path: string; question: string; everySeconds?: number; atSeconds?: number[]; phrases?: string[]; pointing?: boolean }) => Promise<string>;
  /** `video_digest`: frames (with paths to Read) and the transcript of a video. */
  onVideoDigest?: (input: { path: string; everySeconds?: number; atSeconds?: number[]; phrases?: string[]; pointing?: boolean }) => Promise<string>;
  /**
   * When set, the agent gets a `preview_worktree` tool that starts (or reuses) an
   * ephemeral dev server for this task's worktree and returns its URL, so the
   * browser MCP can screenshot the agent's own changes rather than the base app.
   */
  onStartPreview?: () => Promise<{ url: string }>;
  /** `stop_preview`: shut the preview dev server of this task down (same condition as `onStartPreview`). */
  onStopPreview?: () => Promise<{ stopped: boolean }>;
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
  tasksList: (input: { status?: string; limit?: number; order?: string; olderThanDays?: number; project?: string }) => Promise<string>;
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
  /** Updating the server: status is read-only; starting an update is human-approved. */
  updateStatus: () => Promise<string>;
  proposeUpdate: (input: { version?: string; force?: boolean; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Where the server answers: status is read-only; domains / Cloudflare Access changes are human-approved. */
  accessStatus: () => Promise<string>;
  proposeAllowedDomains: (input: { action: 'add' | 'remove' | 'set' | 'clear'; domains?: string[]; reason: string }) => Promise<{ ok: boolean; message: string }>;
  proposeCloudflareAccess: (input: { enabled: boolean; teamDomain: string; aud?: string; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Content packs: read-only overview, and install one — human-approved (never overwrites; schedules arrive switched off). */
  packsList: () => Promise<string>;
  proposePackInstall: (input: { name: string; timezone?: string; project?: string; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Text notes in a resource library (global, or a project's with `project`): create/update/delete — human-approved. (Reading/searching: the general resources_search tool.) */
  proposeResource: (input: {
    action: 'create' | 'update' | 'delete';
    id?: string;
    title?: string;
    description?: string;
    tags?: string[];
    agents?: string[];
    text?: string;
    project?: string;
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
  proposeTask: (input: { agentName: string; prompt: string; title?: string; standalone?: boolean; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** The admin's own change journal (what it changed, which changes can be reverted). */
  adminHistory: (input: { limit?: number }) => Promise<string>;
  /** Change a few platform settings — human-approved, previous values are journaled for undo. */
  proposeSettings: (input: { changes: Record<string, unknown>; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Revert an earlier admin change from the journal — human-approved. */
  proposeUndo: (input: { changeId: string; reason: string }) => Promise<{ ok: boolean; message: string }>;
  /** Why did a task end the way it did: status, error, agent/provider, reported summary, approvals, last messages. */
  taskDiagnose: (taskId: string) => Promise<string>;
  /** The dashboard page the person is on while talking to the admin (a task page → that task's details; a project page → the project). */
  currentContext: () => Promise<string>;
  /** Token / request / cost usage per provider over the last N days. */
  usageReport: (input: { days?: number; project?: string }) => Promise<string>;
  /** Approvals / tasks / agents / config numbers over the last N days, as Markdown tables. Read-only. */
  metricsReport: (input: { topic: string; days?: number; project?: string; agent?: string }) => Promise<string>;
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
  | { kind: 'discussion'; speaker: string; text: string }
  /** A subtask's report as shown in its lead's conversation: a message FROM the subtask's agent (not from the person). */
  | { kind: 'subtask_report'; speaker: string; text: string }
  | { kind: 'assistant'; text: string; /** pictures shown with this message (task attachment names) — show_images */ attachments?: string[] }
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

/**
 * Running totals of a whole Claude session as the SDK reports them on the
 * result message (`modelUsage` summed over models + `total_cost_usd`):
 * subagents included, and — on a resumed session — the earlier calls' spend
 * restored from the transcript. The caller stores the DELTA against what it
 * already attributed to that session (X-COST-1/2).
 */
export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface AgentRunResult {
  /** Claude session id captured from the init event (null if never seen). */
  sessionId: string | null;
  isError: boolean;
  /** Final result text (or error description). */
  result: string;
  /** True when the run ended by hitting maxTurns (subtype error_max_turns). */
  maxTurnsExceeded: boolean;
  /**
   * Usage from the SDK result message (zeroed when none was reported). For the
   * Claude runtime: this call's main loop only, with `costUsd` = the session's
   * running total (see `sessionTotals`). For Codex: per-turn sums of this run.
   */
  usage: RunUsage;
  /** Claude runtime only, and only when a result message arrived: the session's running totals. */
  sessionTotals?: SessionTotals;
}

export type AgentEventHandler = (event: AgentEvent) => void;
