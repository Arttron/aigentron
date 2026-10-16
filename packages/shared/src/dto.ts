/**
 * Request/response DTO shapes for the orchestrator REST API. Kept framework-free
 * here; the NestJS layer adds validation decorators around these shapes.
 */
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
  extraWriteRoots?: string[];
}

/** Synchronous response telling the hook whether to allow without blocking. */
export interface HookCheckResponse {
  /** When true the hook may exit 0 immediately. */
  allow: boolean;
  /** Present when !allow: poll this approval id for the verdict. */
  approvalId?: string;
  reason?: string;
}
