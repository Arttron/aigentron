import type {
  AgentQuestion,
  AgentSession,
  ApprovalRequest,
  ChannelKind,
  PendingFollowUp,
  Project,
  ProjectIsolation,
  ProjectKind,
  ProjectRepoAuth,
  QuestionStatus,
  Task,
  TaskStatus,
  UsageReport,
  User,
  UserRole,
} from '@lds/shared';
import { uploadSizeError } from './upload-limits';
import { API_BASE } from './config';
import { buildQuery, request, setActingHeaders } from './http';

export { ApiError, errMsg } from './http';

/** Body for create/update user. */
export type UserInput = {
  displayName?: string;
  role?: UserRole;
  identities?: { channel: ChannelKind; externalId: string }[];
};

// ---------------------------------------------------------------------------
// Acting user (no auth in v1): the selected user's id is stored client-side and
// sent as the `x-lds-user` header so the orchestrator can attribute + authorize
// actions. Absent → the orchestrator falls back to the default operator.
// ---------------------------------------------------------------------------
const USER_KEY = 'lds.userId';

export function getActingUserId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(USER_KEY);
}

export function setActingUserId(id: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) window.localStorage.setItem(USER_KEY, id);
  else window.localStorage.removeItem(USER_KEY);
}

/** Headers carrying the acting user (added to every call by request()). */
setActingHeaders((): Record<string, string> => {
  const id = getActingUserId();
  return id ? { 'x-lds-user': id } : {};
});

/** Task as returned by the list endpoint (with pending-approval/session counts). */
export type TaskListItem = Task & {
  _count?: { approvals: number; sessions: number };
};

/** One page of the task list. */
export interface TaskPage {
  items: TaskListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Query params for the paginated/searchable task list. */
export type TaskStatusFilter = 'queued' | 'running' | 'needs_approval' | 'review' | 'done' | 'blocked' | 'failed' | 'stalled' | 'cancelled' | 'active' | 'attention';

export type TaskTypeFilter = 'task' | 'subtask' | 'chat' | 'scheduled' | 'channel' | 'discussion';

export interface ListTasksParams {
  q?: string;
  type?: TaskTypeFilter;
  status?: TaskStatusFilter;
  /** A project's slug (the default project is `default`). */
  project?: string;
  page?: number;
  pageSize?: number;
}

/** A task shown as a subtask/parent/reference (minimal fields). */
export interface TaskRef {
  id: string;
  title: string;
  status: TaskStatus;
  agentName?: string | null;
}

/** A referenced task plus its latest reported summary, for context display. */
export interface TaskLinkOut {
  toTaskId: string;
  to: TaskRef & { sessions: { reportedSummary: string | null }[] };
}

/** Task as returned by the detail endpoint (with relations). */
export type TaskDetail = Task & {
  sessions: AgentSession[];
  approvals: ApprovalRequest[];
  parent: TaskRef | null;
  subtasks: TaskRef[];
  linksOut: TaskLinkOut[];
};

/** The shared workspace (memory / work / deliverables). */
export interface WorkspaceSummary {
  root: string;
  bytes: number;
  folders: Record<string, { files: number; bytes: number }>;
}
export interface WorkspaceEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: string;
}
export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
  writable: boolean;
}

/** An AI model endpoint (from GET /api/providers; secret masked). */
export type LoginPhase = 'starting' | 'awaiting_browser' | 'awaiting_code' | 'finishing' | 'done' | 'failed' | 'cancelled';
export interface LoginView {
  phase: LoginPhase;
  url: string | null;
  userCode: string | null;
  needsCode: boolean;
  message: string;
  startedAt: string;
  finishedAt: string | null;
}
export interface LoginStatus {
  supported: boolean;
  flavor: 'codex' | 'claude' | null;
  loggedIn: boolean;
  message: string;
  session: LoginView | null;
}

export type ProviderKind = 'anthropic' | 'openai' | 'deepseek' | 'ollama' | 'codex';
// oauth-token: a CLI-minted subscription token (e.g. `claude setup-token`) —
// bypasses LiteLLM; see @lds/shared resolveProvider().
export type ProviderAuthMode = 'api-key' | 'auth-token' | 'oauth-token' | 'codex-login';

export interface ProviderInfo {
  name: string;
  /** Upstream family → LiteLLM backend. */
  kind: ProviderKind;
  baseUrl: string | null;
  /** Optional default model — agents may override with their own. */
  model: string;
  authMode: ProviderAuthMode;
  secretSet: boolean;
  secretHint: string | null;
  /** Optional LiteLLM-enforced rate caps (null = no cap). */
  rpm: number | null;
  tpm: number | null;
  updatedAt: string;
}

export type ProviderInput = {
  kind?: ProviderKind;
  baseUrl?: string;
  model?: string;
  authMode?: ProviderAuthMode;
  secret?: string;
  rpm?: number;
  tpm?: number;
};

/** Result of POST /api/providers/:name/test (a "whoami" connectivity check). */
export interface ProviderTestResult {
  ok: boolean;
  model?: string;
  reply?: string;
  latencyMs?: number;
  status?: number;
  error?: string;
  /** Structured tool-use support (agents need true); undefined = not probed. */
  toolUse?: boolean;
  toolUseNote?: string;
}

/** Result of GET /api/providers/:name/models. */
export interface ProviderModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/** A LiteLLM proxy route (GET /api/litellm/routes). */
export interface LitellmRoute {
  modelName: string;
  backend: string | null;
  apiBase: string | null;
  /** True for routes the orchestrator manages from OpenAI-native providers. */
  managed: boolean;
}

/** A named agent definition (summary, from GET /api/agents). */
export interface AgentInfo {
  name: string;
  description: string;
  provider?: string;
  /** Provider names to fail over to (in order) if the primary run errors. */
  fallbackProviders?: string[];
  model?: string;
  skills?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  mcp?: string[];
}

/** Full agent definition (with system-prompt body) from GET /api/agents/:name. */
export interface AgentDetail extends AgentInfo {
  instructions: string;
}

/** Body for create/update agent. List fields are comma-separated. */
export type AgentBody = {
  description?: string;
  provider?: string;
  fallbackProviders?: string;
  model?: string;
  skills?: string;
  allowedTools?: string;
  disallowedTools?: string;
  mcp?: string;
  instructions: string;
};

/** An MCP server registry entry (config is the Claude Agent SDK config). */
export interface McpServerInfo {
  name: string;
  config: Record<string, unknown>;
  updatedAt: string;
}

/** Masked state of a secret config field (never the value). */
export interface ChannelSecretState {
  set: boolean;
  hint: string | null;
}

/** A communication channel; secret fields masked to a hint. */
export interface PackInfo {
  name: string;
  title: string;
  icon?: string;
  description: string;
  audience?: string;
  agents?: string[];
  catalogAgents?: string[];
  skills?: string[];
  resources?: { file: string; title: string; description?: string; tags?: string[] }[];
  schedules?: { name: string; cron: string; agent: string; text: string }[];
  after?: string;
  installed: { agents: number; skills: number; resources: number; schedules: number };
  total: { agents: number; skills: number; resources: number; schedules: number };
}

export interface PackInstallResult {
  pack: string;
  added: { agents: string[]; skills: string[]; resources: string[]; schedules: string[] };
  skipped: string[];
  problems: string[];
  after?: string;
  summary: string;
}

export interface ResourceInfo {
  id: string;
  title: string;
  description: string;
  tags: string[];
  kind: 'text' | 'image' | 'pdf' | 'video' | 'file';
  originalName: string;
  mime: string;
  size: number;
  /** Empty = for every agent. */
  agents: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  /** Only on the single-resource fetch of a text resource. */
  text?: string;
  /** The project's slug when scoped to a project; null/absent = global (every agent of every project). */
  project?: string | null;
}

/** Which items a list shows: `all` (default), `global` only, or one project's slug. */
export type ScopeParam = string;
export interface ProjectLibraryCounts {
  resources?: number;
  knowledge?: number;
}
/** What happens to a project's own library when the project is deleted (default `keep` = it becomes global). */
export interface DeleteProjectOptions {
  knowledge?: 'keep' | 'delete';
  resources?: 'keep' | 'delete';
}

export interface ScheduleInfo {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  /** Human description, e.g. "every day at 09:30 (Europe/Kyiv)". */
  when: string;
  kind: 'message' | 'task';
  text: string;
  agentName: string | null;
  /** task kind: `same` = every run continues one task, `new` = every run starts a new task */
  taskMode: 'same' | 'new';
  taskId: string | null;
  channelId: string | null;
  chatId: string | null;
  quietStart: string | null;
  quietEnd: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

export type ScheduleInput = Partial<Pick<ScheduleInfo, 'name' | 'enabled' | 'cron' | 'timezone' | 'kind' | 'text' | 'agentName' | 'taskMode' | 'channelId' | 'chatId' | 'quietStart' | 'quietEnd'>>;

export interface ChannelInfo {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  /** Non-secret config values, keyed by field. */
  config: Record<string, unknown>;
  /** Masked state per secret field. */
  secrets: Record<string, ChannelSecretState>;
  createdAt: string;
  updatedAt: string;
}

/** One config input for a channel kind (drives the dynamic form). */
export interface ChannelFieldMeta {
  key: string;
  label: string;
  type: 'text' | 'password' | 'list' | 'agent';
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

/** A channel kind + its config schema (Telegram available; others planned). */
export interface ChannelKindMeta {
  kind: string;
  label: string;
  available: boolean;
  fields: ChannelFieldMeta[];
  hint?: string;
}

export type ChannelInput = {
  name?: string;
  kind?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
};

export interface ChannelTestResult {
  ok: boolean;
  info?: string;
  error?: string;
}

/** A task attachment (image/PDF). */
export interface AttachmentMeta {
  name: string;
  /** what the person called the file, when the stored name was converted to plain ASCII */
  originalName?: string;
  size: number;
  mime: string;
}

/** A persisted transcript line. */
export interface TranscriptEvent {
  id: string;
  taskId: string;
  agentSessionId: string;
  seq: number;
  kind: string;
  text: string;
  attachments?: string[];
  /** who said it (kind 'discussion') */
  speaker?: string | null;
  createdAt: string;
}

/** Runtime settings as returned by GET /api/settings (secrets masked). */
export interface Settings {
  approvalTimeoutSeconds: number;
  verifyCommands: string;
  verifyMaxAttempts: number;
  /** Max agent runs processed in parallel. */
  concurrency: number;
  debugMode: boolean;
  agentInstructions: string;
  defaultProvider: string | null;
  defaultAgent: string | null;
  /** Default escalation destination for tasks with no channel of their own. */
  notifyChannelId: string | null;
  notifyChatId: string | null;
  repoUrl: string | null;
  repoBranch: string;
  /** Project subdirectory within the workspace repo agents work in ('' = root). */
  workspaceSubdir: string;
  updatedAt: string;
  githubTokenSet: boolean;
  githubTokenHint: string | null;
}

export type SettingsUpdate = Partial<{
  approvalTimeoutSeconds: number;
  verifyCommands: string;
  verifyMaxAttempts: number;
  concurrency: number;
  debugMode: boolean;
  agentInstructions: string;
  defaultProvider: string;
  defaultAgent: string;
  notifyChannelId: string;
  notifyChatId: string;
  repoUrl: string;
  repoBranch: string;
  workspaceSubdir: string;
  githubToken: string;
}>;

export interface KbChunking {
  strategy: 'section' | 'paragraph' | 'chars';
  maxChars: number;
  overlap: number;
  minChars: number;
}
export interface KbInfo {
  id: string;
  name: string;
  description: string;
  agents: string[];
  chunking: KbChunking;
  embedProvider: string | null;
  embedModel: string | null;
  embedDim: number | null;
  agentWrite: boolean;
  docs: number;
  chunks: number;
  embedded: number;
  createdAt: string;
  /** The project's slug when scoped to a project; null/absent = global. */
  project?: string | null;
}
export interface KbInput {
  name?: string;
  description?: string;
  agents?: string[];
  chunking?: KbChunking;
  agentWrite?: boolean;
  embedProvider?: string;
  embedModel?: string;
  /** Slug of the project to scope the base to; omitted = global. */
  project?: string;
}
export interface KbDoc {
  id: string;
  title: string;
  source: string | null;
  kind: string;
  size: number;
  chunks: number;
  createdAt: string;
}
export interface KbAdded {
  docId: string;
  chunks: number;
  duplicate: boolean;
}
export interface KbHit {
  kb: string;
  docId: string;
  docTitle: string;
  source: string | null;
  chunk: number;
  heading: string;
  text: string;
  score: number;
}

/** Fields of POST /projects and PATCH /projects/:slug (all optional on update; `archived` is PATCH-only). */
export interface ProjectInput {
  name?: string;
  slug?: string;
  kind?: ProjectKind;
  repoUrl?: string | null;
  repoBranch?: string;
  repoSubdir?: string | null;
  isolation?: ProjectIsolation | null;
  verifyCommands?: string | null;
  verifyMaxAttempts?: number;
  defaultAgent?: string | null;
  notifyChannelId?: string | null;
  notifyChatId?: string | null;
  archived?: boolean;
}

export type RepoProviderKind = 'github' | 'gitlab' | 'bitbucket' | 'generic';

/** One line of a connection test (ok null = skipped / not applicable). */
export interface RepoTestStep {
  id: 'url' | 'network' | 'auth' | 'branch' | 'write' | 'size';
  label: string;
  ok: boolean | null;
  detail: string;
  hint?: string;
}
export interface RepoTestResult {
  ok: boolean;
  provider: RepoProviderKind;
  steps: RepoTestStep[];
  defaultBranch?: string;
  durationMs: number;
}

/** A project's repository settings (GET /projects/:slug/repo). Secrets are never returned: only whether one is set and its last characters. */
export interface RepoInfo {
  url: string | null;
  branch: string;
  subdir: string | null;
  provider: RepoProviderKind;
  auth: ProjectRepoAuth;
  tokenSet: boolean;
  tokenHint: string | null;
  sshPublicKey: string | null;
  sshFingerprint: string | null;
  hostKeyTrusted: boolean | null;
  lastTest: (RepoTestResult & { at?: string }) | null;
}

/** Credentials are sent once and never read back. */
export type RepoCredentials = { auth: 'none' } | { auth: 'token'; token: string } | { auth: 'ssh'; action: 'generate' } | { auth: 'ssh'; action: 'import'; privateKey: string };

/** An optional server component (docs/addons.md) — installed on the server with `aigentron addon enable`; the status is live. */
export type AddonStatus = 'not-installed' | 'enabled-healthy' | 'enabled-unreachable' | 'disabled';
export interface AddonInfo {
  name: string;
  title: string;
  description: string;
  requires: { ramMb: number; diskMb: number };
  ports: { view: number; cdp: number };
  backends: ('bare' | 'docker')[];
  status: AddonStatus;
  state: {
    enabled: boolean;
    backend: 'bare' | 'docker';
    version: string;
    installedAt: string | null;
    browser: string | null;
    arch: string | null;
    endpoints: { view: string | null; cdp: string | null };
    profiles: string[];
    notes: string[];
  } | null;
  /** Why a present state file was ignored (the add-on then counts as not installed). */
  stateError: string | null;
  health: { ok: boolean; checkedAt: string; error: string | null } | null;
  /** The exact commands to run on the server (the dashboard never runs them). */
  commands: { enable: string; enableDocker: string; disable: string; logs: string };
  /** The dashboard-side proxy of the add-on's page, with the viewing limits (browser add-on only). */
  view: { path: string; maxSessions: number; sessionMinutes: number; active: number } | null;
}

const e = encodeURIComponent;
const octet = (file: File, type = 'application/octet-stream') => ({ 'content-type': type, 'x-filename': e(file.name) });

export interface McpHostStatus {
  enabled: boolean;
  tokenRequired: boolean;
  allowedOrigins: string[];
  activeSessions: number;
  path: string;
}

type KbChunkPreview = { total: number; avg: number; max: number; chunks: { heading: string; chars: number; text: string }[] };
type MaintenanceReport = {
  runs: { count: number; bytes: number; stale: number; staleBytes: number };
  worktrees: { count: number; bytes: number; stale: number };
  attachments: { bytes: number; oldTasksBytes: number };
  caches: { digests: { count: number; bytes: number; stale: number; staleBytes: number }; research: { count: number; bytes: number; stale: number; staleBytes: number }; digestRetentionDays: number; researchRetentionDays: number };
  resources: { bytes: number };
  workspace?: { bytes: number };
  retentionDays: number;
};
type DiskStatus = { path: string; totalBytes: number; freeBytes: number; usedPercent: number; level: 'ok' | 'warn' | 'critical'; warnBelowBytes: number; criticalBelowBytes: number; checkedAt: string; relief?: { at: string; bytes: number } | null };
type TitleCfg = { enabled: boolean; provider: string; model: string };
type VisionCfg = { provider: string; model: string };

// Every method is one request() call: the path, the verb and the result type. Nothing else lives here.
export const api = {
  getMcpStatus: () => request<McpHostStatus>('GET', '/mcp/status'),

  listTasks: (params: ListTasksParams = {}, signal?: AbortSignal) =>
    request<TaskPage | TaskListItem[]>('GET', '/tasks', {
      query: { q: params.q || undefined, type: params.type || undefined, status: params.status || undefined, project: params.project || undefined, page: params.page || undefined, pageSize: params.pageSize || undefined },
      signal,
    }).then((data): TaskPage => (Array.isArray(data) ? { items: data, total: data.length, page: 1, pageSize: data.length || 1 } : data)),

  taskStatusCounts: (type?: TaskTypeFilter, signal?: AbortSignal) => request<Record<TaskStatusFilter, number>>('GET', '/tasks/status-counts', { query: { type: type || undefined }, signal }),
  taskTypeCounts: (signal?: AbortSignal) => request<Record<TaskTypeFilter | 'all', number>>('GET', '/tasks/type-counts', { signal }),

  getTask: (id: string) => request<TaskDetail>('GET', `/tasks/${id}`),
  transcript: (id: string) => request<TranscriptEvent[]>('GET', `/tasks/${id}/transcript`),
  markTaskDone: (id: string, cancelOpenSubtasks = false) => request<unknown>('POST', `/tasks/${e(id)}/done`, { body: { cancelOpenSubtasks } }),
  startTask: (id: string, attachments?: string[]) => request<Task>('POST', `/tasks/${e(id)}/start`, { body: { attachments } }),

  createTask: (body: { prompt: string; title?: string; agentName?: string; attachments?: string[]; autostart?: boolean; parentId?: string; references?: string[]; project?: string }) =>
    request<Task>('POST', '/tasks', { body }),
  providerLogin: (name: string) => request<LoginStatus>('GET', `/providers/${e(name)}/login`),
  providerLoginStart: (name: string) => request<LoginView>('POST', `/providers/${e(name)}/login/start`),
  providerLoginCode: (name: string, code: string) => request<LoginView>('POST', `/providers/${e(name)}/login/code`, { body: { code } }),
  providerLoginCancel: (name: string) => request<LoginView | null>('DELETE', `/providers/${e(name)}/login`),
  providerLogout: (name: string) => request<LoginStatus>('POST', `/providers/${e(name)}/logout`),
  /** Tell the admin chat which page the person is on (its `current_context` tool reads it). */
  setAdminContext: (taskId: string, page: { path: string; title?: string }) => request<{ ok: true }>('PUT', `/admin-context/${e(taskId)}`, { body: page }),
  createSubtask: (parentId: string, body: { prompt: string; title?: string; agentName?: string }) => request<Task>('POST', `/tasks/${e(parentId)}/subtasks`, { body }),

  listAgents: () => request<AgentInfo[]>('GET', '/agents'),

  getAdminAudit: (id: string) =>
    request<{ id: string; ts: string; tool: string; summary: string; undone?: boolean; undo?: { kind: string; name?: string; before?: unknown } }>('GET', `/admin-audit/${e(id)}`),

  submitSecret: (approvalId: string, value: string) => request<unknown>('POST', `/approvals/${e(approvalId)}/secret`, { body: { value } }),

  maintenanceDryRun: (body: { runs?: boolean; worktrees?: boolean; deleteBranches?: boolean; olderThanDays?: number }) =>
    request<{ runsRemoved: number; runBytes: number; worktreesRemoved: number; branchesDeleted: number }>('POST', '/maintenance/cleanup', { body: { ...body, dryRun: true } }),

  listAgentTemplates: () => request<AgentInfo[]>('GET', '/agents/catalog'),
  getAgentTemplate: (name: string) => request<AgentDetail>('GET', `/agents/catalog/${e(name)}`),
  getAgent: (name: string) => request<AgentDetail>('GET', `/agents/${e(name)}`),
  createAgent: (body: { name: string } & AgentBody) => request<AgentDetail>('POST', '/agents', { body }),
  updateAgent: (name: string, body: AgentBody) => request<AgentDetail>('PUT', `/agents/${e(name)}`, { body }),
  deleteAgent: (name: string) => request<{ name: string }>('DELETE', `/agents/${e(name)}`),

  listMcp: () => request<McpServerInfo[]>('GET', '/mcp-servers'),
  createMcp: (body: { name: string; config: Record<string, unknown> }) => request<McpServerInfo>('POST', '/mcp-servers', { body }),
  updateMcp: (name: string, config: Record<string, unknown>) => request<McpServerInfo>('PUT', `/mcp-servers/${e(name)}`, { body: { config } }),
  discoverMcp: (name: string) => request<{ trusted: boolean; tools: { name: string; readOnly: boolean }[] }>('POST', `/mcp-servers/${e(name)}/discover`),
  deleteMcp: (name: string) => request<{ name: string }>('DELETE', `/mcp-servers/${e(name)}`),

  listChannelKinds: () => request<ChannelKindMeta[]>('GET', '/channels/kinds'),
  listPairings: (channelId: string) =>
    request<{ chatId: string; userName: string | null; firstText: string | null; attempts: number; lastSeen: string }[]>('GET', `/channels/${e(channelId)}/pairings`),
  allowPairing: (channelId: string, chatId: string) => request<unknown>('POST', `/channels/${e(channelId)}/pairings/${e(chatId)}/allow`),
  dismissPairing: (channelId: string, chatId: string) => request<unknown>('DELETE', `/channels/${e(channelId)}/pairings/${e(chatId)}`),

  listPacks: () => request<PackInfo[]>('GET', '/packs'),
  getPack: (name: string) => request<PackInfo>('GET', `/packs/${e(name)}`),
  installPack: (name: string, timezone?: string) => request<PackInstallResult>('POST', `/packs/${e(name)}/install`, { body: { timezone } }),

  listResources: (project?: ScopeParam) =>
    request<{ items: ResourceInfo[]; usage: { count: number; bytes: number; maxCount: number; maxBytes: number } }>('GET', '/resources', { query: { project } }),
  getResource: (id: string) => request<ResourceInfo>('GET', `/resources/${e(id)}`),
  createNote: (body: { title: string; description?: string; tags?: string[]; agents?: string[]; text: string; project?: string }) => request<ResourceInfo>('POST', '/resources', { body }),
  uploadResource: (file: File, project?: string) =>
    request<ResourceInfo>('POST', '/resources/upload', { raw: file, headers: { ...octet(file), ...(project ? { 'x-project': project } : {}) } }),
  updateResource: (id: string, body: { title?: string; description?: string; tags?: string[]; agents?: string[]; text?: string; project?: string | null }) => request<ResourceInfo>('PUT', `/resources/${e(id)}`, { body }),
  deleteResource: (id: string) => request<{ id: string }>('DELETE', `/resources/${e(id)}`),
  resourceUrl: (id: string) => `${API_BASE}/resources/${e(id)}/file`,

  translate: (text: string, to: string) => request<{ ok: boolean; text?: string; error?: string }>('POST', '/translate', { body: { text, to } }),
  startDiscussion: (body: { taskId?: string; topic: string; agents: string[]; rounds?: number; language?: 'compact' | 'user'; summaryBy?: string | null }) =>
    request<{ taskId: string }>('POST', '/discussions', { body }),
  discussionState: (taskId: string) =>
    request<{ active: boolean; topic?: string; agents?: string[]; turn?: number; total?: number; speaker?: string | null; summaryBy?: string | null }>('GET', `/discussions/${e(taskId)}`),
  concludeDiscussion: (taskId: string) => request<{ ok: boolean }>('POST', `/discussions/${e(taskId)}/conclude`),
  stopDiscussion: (taskId: string) => request<{ ok: boolean }>('POST', `/discussions/${e(taskId)}/stop`),

  listKb: (project?: ScopeParam) => request<KbInfo[]>('GET', '/knowledge', { query: { project } }),
  createKb: (body: KbInput) => request<KbInfo>('POST', '/knowledge', { body }),
  updateKb: (name: string, body: Omit<Partial<KbInput>, 'embedProvider' | 'embedModel' | 'project'> & { embedProvider?: string | null; embedModel?: string | null; project?: string | null }) =>
    request<KbInfo>('PATCH', `/knowledge/${e(name)}`, { body }),
  deleteKb: (name: string) => request<{ name: string }>('DELETE', `/knowledge/${e(name)}`),
  listKbDocs: (name: string) => request<KbDoc[]>('GET', `/knowledge/${e(name)}/docs`),
  addKbNote: (name: string, body: { title: string; text: string }) => request<KbAdded>('POST', `/knowledge/${e(name)}/docs/note`, { body }),
  uploadKbFile: (name: string, file: File) => request<KbAdded>('POST', `/knowledge/${e(name)}/docs/upload`, { raw: file, headers: octet(file) }),
  importKbResource: (name: string, id: string) => request<KbAdded>('POST', `/knowledge/${e(name)}/import/resource`, { body: { id } }),
  importKbResearch: (name: string) => request<{ added: number; skipped: number }>('POST', `/knowledge/${e(name)}/import/research`),
  deleteKbDoc: (id: string) => request<{ id: string }>('DELETE', `/knowledge/docs/${e(id)}`),
  searchKb: (name: string, query: string) => request<{ hits: KbHit[]; note?: string }>('POST', `/knowledge/${e(name)}/search`, { body: { query, limit: 6 } }),
  previewKb: (text: string, chunking: KbChunking) => request<KbChunkPreview>('POST', '/knowledge/preview', { body: { text, chunking } }),
  reembedKb: (name: string) => request<{ started: boolean }>('POST', `/knowledge/${e(name)}/reembed`),

  listSchedules: () => request<ScheduleInfo[]>('GET', '/schedules'),
  /** The projects (docs/plan-projects-workspace.md); `archived` includes the archived ones. */
  listProjects: (opts: { archived?: boolean } = {}) => request<Project[]>('GET', '/projects', { query: { archived: opts.archived ? '1' : undefined } }),
  getProject: (slug: string) => request<Project & { counts: ProjectLibraryCounts }>('GET', `/projects/${e(slug)}`),
  createProject: (body: ProjectInput) => request<Project>('POST', '/projects', { body }),
  updateProject: (slug: string, body: ProjectInput) => request<Project>('PATCH', `/projects/${e(slug)}`, { body }),
  archiveProject: (slug: string) => request<Project>('POST', `/projects/${e(slug)}/archive`),
  /** 409 (with the reason in the message) while the project has active tasks. */
  deleteProject: (slug: string, opts?: DeleteProjectOptions) => request<unknown>('DELETE', `/projects/${e(slug)}`, opts ? { body: opts } : {}),
  getProjectRepo: (slug: string) => request<RepoInfo>('GET', `/projects/${e(slug)}/repo`),
  setProjectRepo: (slug: string, body: { url?: string | null; branch?: string; subdir?: string | null }) => request<RepoInfo>('PUT', `/projects/${e(slug)}/repo`, { body }),
  setProjectRepoCredentials: (slug: string, body: RepoCredentials) => request<RepoInfo>('PUT', `/projects/${e(slug)}/repo/credentials`, { body }),
  testProjectRepo: (slug: string, checkWrite = false) => request<RepoTestResult>('POST', `/projects/${e(slug)}/repo/test`, { body: { checkWrite } }),
  syncProjectRepo: (slug: string) => request<{ ok: boolean; message: string; head?: string }>('POST', `/projects/${e(slug)}/repo/sync`),
  createSchedule: (body: ScheduleInput) => request<ScheduleInfo>('POST', '/schedules', { body }),
  updateSchedule: (id: string, body: ScheduleInput) => request<ScheduleInfo>('PUT', `/schedules/${e(id)}`, { body }),
  deleteSchedule: (id: string) => request<{ id: string }>('DELETE', `/schedules/${e(id)}`),
  runSchedule: (id: string) => request<{ status: string; error?: string }>('POST', `/schedules/${e(id)}/run`),

  listChannels: () => request<ChannelInfo[]>('GET', '/channels'),
  createChannel: (body: ChannelInput) => request<ChannelInfo>('POST', '/channels', { body }),
  updateChannel: (id: string, body: ChannelInput) => request<ChannelInfo>('PUT', `/channels/${e(id)}`, { body }),
  deleteChannel: (id: string) => request<{ id: string }>('DELETE', `/channels/${e(id)}`),
  testChannel: (id: string) => request<ChannelTestResult>('POST', `/channels/${e(id)}/test`),

  listProviders: () => request<ProviderInfo[]>('GET', '/providers'),
  createProvider: (body: { name: string } & ProviderInput) => request<ProviderInfo>('POST', '/providers', { body }),
  updateProvider: (name: string, body: ProviderInput) => request<ProviderInfo>('PUT', `/providers/${e(name)}`, { body }),
  deleteProvider: (name: string) => request<{ name: string }>('DELETE', `/providers/${e(name)}`),
  testProvider: (name: string) => request<ProviderTestResult>('POST', `/providers/${e(name)}/test`),
  listProviderModels: (name: string) => request<ProviderModelsResult>('GET', `/providers/${e(name)}/models`),
  previewProviderModels: (body: { kind?: ProviderKind; baseUrl?: string; authMode?: ProviderAuthMode; secret?: string }) => request<ProviderModelsResult>('POST', '/providers/models-preview', { body }),

  listSkills: () => request<string[]>('GET', '/agents/skills'),
  listLitellmRoutes: () => request<LitellmRoute[]>('GET', '/litellm/routes'),

  followUp: (id: string, prompt: string, attachments?: string[], references?: string[]) =>
    request<TaskDetail & { queued: boolean; queueLength: number }>('POST', `/tasks/${id}/follow-up`, { body: { prompt, attachments, references } }),
  listPendingFollowUps: (id: string) => request<PendingFollowUp[]>('GET', `/tasks/${id}/pending-follow-ups`),
  updatePendingFollowUp: (id: string, pendingId: string, patch: { prompt?: string; attachments?: string[]; references?: string[] }) =>
    request<PendingFollowUp[]>('PATCH', `/tasks/${id}/pending-follow-ups/${pendingId}`, { body: patch }),
  removePendingFollowUp: (id: string, pendingId: string) => request<PendingFollowUp[]>('DELETE', `/tasks/${id}/pending-follow-ups/${pendingId}`),

  cancelTask: (id: string) => request<Task>('POST', `/tasks/${id}/cancel`),
  deleteTask: (id: string) => request<{ id: string }>('DELETE', `/tasks/${id}`),

  listAttachments: (id: string) => request<AttachmentMeta[]>('GET', `/tasks/${e(id)}/attachments`),
  uploadAttachment: (id: string, file: File) => {
    const tooBig = uploadSizeError(file);
    if (tooBig) return Promise.reject(new Error(tooBig));
    return request<AttachmentMeta>('POST', `/tasks/${e(id)}/attachments`, { raw: file, headers: octet(file, file.type || 'application/octet-stream') });
  },

  workspaceSummary: () => request<WorkspaceSummary>('GET', '/workspace'),
  workspaceList: (path: string) => request<WorkspaceListing>('GET', '/workspace/files', { query: { path } }),
  workspaceFileUrl: (path: string, download = false) => `${API_BASE}/workspace/file?${new URLSearchParams({ path, ...(download ? { download: '1' } : {}) })}`,
  workspaceText: async (path: string): Promise<string> => {
    const r = await fetch(`${API_BASE}/workspace/file${buildQuery({ path })}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} — could not read the file`);
    return r.text();
  },
  workspaceUpload: (path: string, body: Blob | string) => request<{ path: string; size: number }>('PUT', '/workspace/file', { query: { path }, raw: body, headers: { 'content-type': 'application/octet-stream' } }),
  workspaceDelete: (path: string) => request<{ ok: boolean }>('DELETE', '/workspace/file', { query: { path } }),

  listQuestions: (status?: QuestionStatus, taskId?: string) => request<AgentQuestion[]>('GET', '/questions', { query: { status: status || undefined, taskId: taskId || undefined } }),
  answerQuestion: (id: string, answer: { index?: number; indexes?: number[]; text?: string }) => request<AgentQuestion>('POST', `/questions/${e(id)}/answer`, { body: answer }),
  questionImageUrl: (id: string) => `${API_BASE}/questions/${e(id)}/image`,
  diskStatus: () => request<DiskStatus | null>('GET', '/maintenance/disk'),
  maintenanceReport: () => request<MaintenanceReport>('GET', '/maintenance/report'),
  relieveDisk: () => request<{ digests: number; research: number; runs: number; bytes: number }>('POST', '/maintenance/relieve'),
  getTitleSettings: () => request<TitleCfg>('GET', '/titles'),
  saveTitleSettings: (body: TitleCfg) => request<TitleCfg>('PUT', '/titles', { body }),
  testTitle: (prompt?: string) => request<{ ok: boolean; title?: string; provider?: string; error?: string }>('POST', '/titles/test', { body: { prompt } }),
  mediaStatus: () => request<{ vision: VisionCfg | null; visionReady: boolean; ffmpeg: boolean; sttReady: boolean }>('GET', '/media'),
  saveVision: (cfg: VisionCfg | null) => request<{ ok: boolean; vision: VisionCfg | null }>('PUT', '/vision', { body: cfg ?? {} }),
  testVision: () => request<{ ok: boolean; answer?: string; error?: string }>('POST', '/vision/test'),

  attachmentUrl: (id: string, name: string) => `${API_BASE}/tasks/${e(id)}/attachments/${e(name)}`,

  listApprovals: (status?: string) => request<ApprovalRequest[]>('GET', '/approvals', { query: { status: status || undefined } }),
  decide: (id: string, decision: 'approve' | 'deny', opts?: { taskException?: boolean; globalException?: boolean }) =>
    request<ApprovalRequest>('POST', `/approvals/${id}/decision`, { body: { decision, ...opts } }),

  listUsers: () => request<User[]>('GET', '/users'),
  createUser: (body: { displayName: string } & UserInput) => request<User>('POST', '/users', { body }),
  updateUser: (id: string, body: UserInput) => request<User>('PUT', `/users/${e(id)}`, { body }),
  deleteUser: (id: string) => request<{ id: string }>('DELETE', `/users/${e(id)}`),

  getUsage: (params: { from?: string; to?: string } = {}) => request<UsageReport>('GET', '/stats/usage', { query: { from: params.from || undefined, to: params.to || undefined } }),

  getSettings: () => request<Settings>('GET', '/settings'),
  updateSettings: (body: SettingsUpdate) => request<Settings>('PUT', '/settings', { body }),

  listAddons: () => request<AddonInfo[]>('GET', '/addons'),
  getAddon: (name: string) => request<AddonInfo>('GET', `/addons/${e(name)}`),
  /** The browser add-on's noVNC page, proxied behind the sign-in; `path` tells noVNC where its WebSocket is (host-relative, same proxy). */
  addonBrowserViewUrl: () => `${API_BASE}/addons/browser/view/vnc.html?autoconnect=1&resize=scale&show_dot=1&reconnect=0&path=api/addons/browser/view/websockify`,
};
