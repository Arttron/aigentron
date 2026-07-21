/**
 * Request/response DTO shapes for the orchestrator REST API. Kept framework-free
 * here; the NestJS layer adds validation decorators around these shapes.
 */
import type { ApprovalRequest, ChannelKind, Task, UserRole } from './types';

export interface CreateUserInput {
  displayName: string;
  role?: UserRole;
  /** Optional channel identities to attach up front. */
  identities?: { channel: ChannelKind; externalId: string }[];
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  identities?: { channel: ChannelKind; externalId: string }[];
}

export interface CreateTaskInput {
  prompt: string;
  /** Optional human-friendly title; derived from the prompt when omitted. */
  title?: string;
  /** Optional named agent (see ./agent/agents/<name>.md). */
  agentName?: string;
}

export interface FollowUpInput {
  /** Additional message that continues the same agent conversation (--resume). */
  prompt: string;
}

export interface ApprovalDecisionInput {
  decision: 'approve' | 'deny';
  /** Optional identifier of who decided (no auth in v1, so free-form). */
  decidedBy?: string;
}

/** Payload the PreToolUse hook POSTs to the approvals API. */
export interface HookCheckInput {
  taskId: string;
  agentSessionId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Worktree root, so the orchestrator classifies writes consistently. */
  workspaceRoot?: string;
}

/** Synchronous response telling the hook whether to allow without blocking. */
export interface HookCheckResponse {
  /** When true the hook may exit 0 immediately. */
  allow: boolean;
  /** Present when !allow: poll this approval id for the verdict. */
  approvalId?: string;
  reason?: string;
}

export interface TaskWithRelations extends Task {
  approvals: ApprovalRequest[];
}
