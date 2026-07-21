/**
 * Core domain types shared between the orchestrator, agent-runner, the hook,
 * and the dashboard. These are the canonical shapes; the Prisma schema mirrors
 * them and the DTOs (see dto.ts) are derived from them.
 */

/**
 * Task lifecycle. Values are enum-safe (no hyphens) so they can be reused
 * verbatim as a Prisma enum.
 *
 *   queued -> running -> (needs_approval <-> running) -> done | failed | cancelled
 *
 * Terminal outcomes also include `blocked` (agent reported it can't proceed —
 * needs human input) and `stalled` (the run ended without a status report, e.g.
 * timeout/crash — outcome unknown). Both are terminal so a follow-up can resume.
 */
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'needs_approval'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'stalled';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'running',
  'needs_approval',
  'done',
  'failed',
  'cancelled',
  'blocked',
  'stalled',
] as const;

/** Terminal states — a task in one of these will never change again. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'done',
  'failed',
  'cancelled',
  'blocked',
  'stalled',
] as const;

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** Status of a single agent session (one Claude Code run for a task). */
export type AgentSessionStatus = 'starting' | 'running' | 'completed' | 'errored' | 'cancelled';

/** Verdict lifecycle for a human-in-the-loop approval request. */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timeout';

/**
 * Role of a human participant. Not an auth identity (no credentials in v1) —
 * scopes what the acting user may do at the API layer.
 *   task_setter — create tasks and comment
 *   reviewer    — approve/reject/request changes
 *   operator    — the above + merge/push/deploy confirmations + manage config
 *   admin       — everything
 */
export type UserRole = 'operator' | 'reviewer' | 'task_setter' | 'admin';

export const USER_ROLES: readonly UserRole[] = [
  'operator',
  'reviewer',
  'task_setter',
  'admin',
] as const;

/** A channel a User can be reached on / act from. */
export type ChannelKind = 'dashboard' | 'slack' | 'telegram' | 'email';

export interface ChannelIdentity {
  id: string;
  channel: ChannelKind;
  /** The user's id on that channel (Slack user id, Telegram id, email, …). */
  externalId: string;
}

export interface User {
  id: string;
  displayName: string;
  role: UserRole;
  identities: ChannelIdentity[];
  createdAt: string;
}

export interface Task {
  id: string;
  prompt: string;
  status: TaskStatus;
  /** Short title derived from the prompt for display. */
  title: string;
  /** git branch created for this task (e.g. `agent/task-<id>`). */
  branch: string | null;
  /** Absolute path of the git worktree the agent is confined to. */
  worktreePath: string | null;
  /** Named agent definition driving this task, if any (else the default agent). */
  agentName: string | null;
  /** URL of the pull request opened for this task's branch, if any. */
  prUrl: string | null;
  /** Branch/commit the work was pushed straight to, without a PR (shared mode). */
  pushedTo: string | null;
  /** Last error message if the task failed. */
  error: string | null;
  /** Id of the user who created the task (null for pre-identity tasks). */
  createdById: string | null;
  /** Parent task when this is a subtask from decomposition (null = top-level). */
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  taskId: string;
  status: AgentSessionStatus;
  /** Name of the provider the session ran on. */
  provider: string;
  model: string;
  /** The Claude Code session id, captured from the SDK init event (for --resume). */
  claudeSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  agentSessionId: string | null;
  /** Tool the agent is about to call (e.g. "Bash", "Write"). */
  toolName: string;
  /** Raw tool input as provided by the agent. */
  toolInput: Record<string, unknown>;
  /** Human-readable summary of the action (e.g. the shell command). */
  summary: string;
  /** Why the classifier flagged this as dangerous. */
  reason: string;
  status: ApprovalStatus;
  /** Human-readable label of who/what resolved it (display name or 'system:timeout'). */
  resolvedBy: string | null;
  /** Id of the user who resolved it, when a human did (null for system:timeout). */
  resolvedById: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Usage aggregated for one provider over a time range (per-provider stats). */
export interface ProviderUsage {
  provider: string;
  /** Number of agent sessions (runs) attributed to this provider. */
  sessions: number;
  /** Σ agentic turns — the "requests" metric. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Σ cache-read + cache-creation tokens. */
  cacheTokens: number;
  /** Σ SDK cost estimate — accurate for Anthropic, approximate/0 via LiteLLM. */
  estCostUsd: number;
}

/** Fleet usage over a time range: per-provider rows plus their totals. */
export interface UsageReport {
  /** Range echoed from the query (ISO 8601; null = unbounded on that side). */
  from: string | null;
  to: string | null;
  totals: Omit<ProviderUsage, 'provider'>;
  providers: ProviderUsage[];
}
