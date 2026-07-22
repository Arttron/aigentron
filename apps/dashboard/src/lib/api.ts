import type {
  AgentSession,
  ApprovalRequest,
  ChannelKind,
  Task,
  TaskStatus,
  UsageReport,
  User,
  UserRole,
} from '@lds/shared';
import { API_BASE } from './config';

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

/** Headers carrying the acting user, optionally with a JSON content-type. */
function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = json ? { 'content-type': 'application/json' } : {};
  const id = getActingUserId();
  if (id) h['x-lds-user'] = id;
  return h;
}

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
export interface ListTasksParams {
  q?: string;
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

/** An AI model endpoint (from GET /api/providers; secret masked). */
export type ProviderKind = 'anthropic' | 'openai' | 'deepseek' | 'ollama';
// oauth-token: a CLI-minted subscription token (e.g. `claude setup-token`) —
// bypasses LiteLLM; see @lds/shared resolveProvider().
export type ProviderAuthMode = 'api-key' | 'auth-token' | 'oauth-token';

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
  createdAt: string;
}

/** Runtime settings as returned by GET /api/settings (secrets masked). */
export interface Settings {
  approvalTimeoutSeconds: number;
  verifyCommands: string;
  verifyMaxAttempts: number;
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

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }
  return res.json() as Promise<T>;
}

const jsonHeaders = { 'content-type': 'application/json' };

/** Safe status of the hosted MCP entry point (never includes the token value). */
export interface McpHostStatus {
  enabled: boolean;
  tokenRequired: boolean;
  allowedOrigins: string[];
  activeSessions: number;
  path: string;
}

export const api = {
  getMcpStatus: () =>
    fetch(`${API_BASE}/mcp/status`, { cache: 'no-store' }).then(unwrap<McpHostStatus>),

  listTasks: (params: ListTasksParams = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    const suffix = qs.toString() ? `?${qs}` : '';
    return fetch(`${API_BASE}/tasks${suffix}`, { cache: 'no-store' })
      .then(unwrap<TaskPage | TaskListItem[]>)
      .then((data): TaskPage =>
        // Tolerate an orchestrator that hasn't restarted yet (old array shape).
        Array.isArray(data)
          ? { items: data, total: data.length, page: 1, pageSize: data.length || 1 }
          : data,
      );
  },

  getTask: (id: string) =>
    fetch(`${API_BASE}/tasks/${id}`, { cache: 'no-store' }).then(unwrap<TaskDetail>),

  transcript: (id: string) =>
    fetch(`${API_BASE}/tasks/${id}/transcript`, { cache: 'no-store' }).then(
      unwrap<TranscriptEvent[]>,
    ),

  startTask: (id: string, attachments?: string[]) =>
    fetch(`${API_BASE}/tasks/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ attachments }),
    }).then(unwrap<Task>),

  createTask: (body: {
    prompt: string;
    title?: string;
    agentName?: string;
    attachments?: string[];
    autostart?: boolean;
    parentId?: string;
    references?: string[];
  }) =>
    fetch(`${API_BASE}/tasks`, { method: 'POST', headers: authHeaders(true), body: JSON.stringify(body) }).then(
      unwrap<Task>,
    ),

  /** Create + enqueue a subtask under a parent task. */
  createSubtask: (parentId: string, body: { prompt: string; title?: string; agentName?: string }) =>
    fetch(`${API_BASE}/tasks/${encodeURIComponent(parentId)}/subtasks`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(body),
    }).then(unwrap<Task>),

  listAgents: () => fetch(`${API_BASE}/agents`, { cache: 'no-store' }).then(unwrap<AgentInfo[]>),

  getAgent: (name: string) =>
    fetch(`${API_BASE}/agents/${encodeURIComponent(name)}`, { cache: 'no-store' }).then(
      unwrap<AgentDetail>,
    ),

  createAgent: (body: { name: string } & AgentBody) =>
    fetch(`${API_BASE}/agents`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) }).then(
      unwrap<AgentDetail>,
    ),

  updateAgent: (name: string, body: AgentBody) =>
    fetch(`${API_BASE}/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    }).then(unwrap<AgentDetail>),

  deleteAgent: (name: string) =>
    fetch(`${API_BASE}/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(
      unwrap<{ name: string }>,
    ),

  listMcp: () =>
    fetch(`${API_BASE}/mcp-servers`, { cache: 'no-store' }).then(unwrap<McpServerInfo[]>),

  createMcp: (body: { name: string; config: Record<string, unknown> }) =>
    fetch(`${API_BASE}/mcp-servers`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) }).then(
      unwrap<McpServerInfo>,
    ),

  updateMcp: (name: string, config: Record<string, unknown>) =>
    fetch(`${API_BASE}/mcp-servers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ config }),
    }).then(unwrap<McpServerInfo>),

  deleteMcp: (name: string) =>
    fetch(`${API_BASE}/mcp-servers/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(
      unwrap<{ name: string }>,
    ),

  listChannelKinds: () =>
    fetch(`${API_BASE}/channels/kinds`, { cache: 'no-store', headers: authHeaders() }).then(
      unwrap<ChannelKindMeta[]>,
    ),

  listChannels: () =>
    fetch(`${API_BASE}/channels`, { cache: 'no-store', headers: authHeaders() }).then(
      unwrap<ChannelInfo[]>,
    ),

  createChannel: (body: ChannelInput) =>
    fetch(`${API_BASE}/channels`, { method: 'POST', headers: authHeaders(true), body: JSON.stringify(body) }).then(
      unwrap<ChannelInfo>,
    ),

  updateChannel: (id: string, body: ChannelInput) =>
    fetch(`${API_BASE}/channels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify(body),
    }).then(unwrap<ChannelInfo>),

  deleteChannel: (id: string) =>
    fetch(`${API_BASE}/channels/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() }).then(
      unwrap<{ id: string }>,
    ),

  testChannel: (id: string) =>
    fetch(`${API_BASE}/channels/${encodeURIComponent(id)}/test`, { method: 'POST', headers: authHeaders() }).then(
      unwrap<ChannelTestResult>,
    ),

  listProviders: () =>
    fetch(`${API_BASE}/providers`, { cache: 'no-store' }).then(unwrap<ProviderInfo[]>),

  createProvider: (body: { name: string } & ProviderInput) =>
    fetch(`${API_BASE}/providers`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    }).then(unwrap<ProviderInfo>),

  updateProvider: (name: string, body: ProviderInput) =>
    fetch(`${API_BASE}/providers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    }).then(unwrap<ProviderInfo>),

  deleteProvider: (name: string) =>
    fetch(`${API_BASE}/providers/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(
      unwrap<{ name: string }>,
    ),

  testProvider: (name: string) =>
    fetch(`${API_BASE}/providers/${encodeURIComponent(name)}/test`, { method: 'POST' }).then(
      unwrap<ProviderTestResult>,
    ),

  listProviderModels: (name: string) =>
    fetch(`${API_BASE}/providers/${encodeURIComponent(name)}/models`, { cache: 'no-store' }).then(
      unwrap<ProviderModelsResult>,
    ),

  previewProviderModels: (body: { kind?: ProviderKind; baseUrl?: string; authMode?: ProviderAuthMode; secret?: string }) =>
    fetch(`${API_BASE}/providers/models-preview`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    }).then(unwrap<ProviderModelsResult>),

  listSkills: () =>
    fetch(`${API_BASE}/agents/skills`, { cache: 'no-store' }).then(unwrap<string[]>),

  listLitellmRoutes: () =>
    fetch(`${API_BASE}/litellm/routes`, { cache: 'no-store' }).then(unwrap<LitellmRoute[]>),

  followUp: (id: string, prompt: string, attachments?: string[], references?: string[]) =>
    fetch(`${API_BASE}/tasks/${id}/follow-up`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ prompt, attachments, references }),
    }).then(unwrap<TaskDetail>),

  cancelTask: (id: string) =>
    fetch(`${API_BASE}/tasks/${id}/cancel`, { method: 'POST' }).then(unwrap<Task>),

  deleteTask: (id: string) =>
    fetch(`${API_BASE}/tasks/${id}`, { method: 'DELETE' }).then(unwrap<{ id: string }>),

  listAttachments: (id: string) =>
    fetch(`${API_BASE}/tasks/${encodeURIComponent(id)}/attachments`, { cache: 'no-store' }).then(
      unwrap<AttachmentMeta[]>,
    ),

  uploadAttachment: (id: string, file: File) =>
    fetch(`${API_BASE}/tasks/${encodeURIComponent(id)}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name),
      },
      body: file,
    }).then(unwrap<AttachmentMeta>),

  attachmentUrl: (id: string, name: string) =>
    `${API_BASE}/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`,

  listApprovals: (status?: string) =>
    fetch(`${API_BASE}/approvals${status ? `?status=${status}` : ''}`, { cache: 'no-store' }).then(
      unwrap<ApprovalRequest[]>,
    ),

  decide: (
    id: string,
    decision: 'approve' | 'deny',
    opts?: { taskException?: boolean; globalException?: boolean },
  ) =>
    fetch(`${API_BASE}/approvals/${id}/decision`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ decision, ...opts }),
    }).then(unwrap<ApprovalRequest>),

  listUsers: () => fetch(`${API_BASE}/users`, { cache: 'no-store' }).then(unwrap<User[]>),

  createUser: (body: { displayName: string } & UserInput) =>
    fetch(`${API_BASE}/users`, { method: 'POST', headers: authHeaders(true), body: JSON.stringify(body) }).then(
      unwrap<User>,
    ),

  updateUser: (id: string, body: UserInput) =>
    fetch(`${API_BASE}/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify(body),
    }).then(unwrap<User>),

  deleteUser: (id: string) =>
    fetch(`${API_BASE}/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }).then(unwrap<{ id: string }>),

  getUsage: (params: { from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const suffix = qs.toString() ? `?${qs}` : '';
    // Guarded (operator/admin): carry the acting user.
    return fetch(`${API_BASE}/stats/usage${suffix}`, {
      cache: 'no-store',
      headers: authHeaders(),
    }).then(unwrap<UsageReport>);
  },

  getSettings: () =>
    fetch(`${API_BASE}/settings`, { cache: 'no-store' }).then(unwrap<Settings>),

  updateSettings: (body: SettingsUpdate) =>
    fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    }).then(unwrap<Settings>),
};
