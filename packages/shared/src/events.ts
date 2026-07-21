/**
 * WebSocket event contract between the orchestrator and the dashboard.
 * The orchestrator emits these; the dashboard subscribes per task and globally.
 */
import type {
  AgentSessionStatus,
  ApprovalRequest,
  ApprovalStatus,
  Task,
  TaskStatus,
} from './types';

/** Socket.IO room names. */
export const ROOM = {
  /** Global feed: task list changes + all pending approvals. */
  global: 'global',
  /** Per-task feed: live log lines + status for one task. */
  task: (taskId: string): string => `task:${taskId}`,
} as const;

/** Server -> client event names. */
export const SERVER_EVENT = {
  taskUpserted: 'task:upserted',
  taskStatus: 'task:status',
  taskDeleted: 'task:deleted',
  agentLog: 'agent:log',
  agentStatus: 'agent:status',
  approvalCreated: 'approval:created',
  approvalResolved: 'approval:resolved',
} as const;

/** Client -> server event names. */
export const CLIENT_EVENT = {
  subscribeTask: 'subscribe:task',
  unsubscribeTask: 'unsubscribe:task',
  /** The dashboard window gained/lost focus (drives approval escalation). */
  focus: 'client:focus',
  blur: 'client:blur',
} as const;

/** A single line/chunk of an agent's streamed output. */
export interface AgentLogEvent {
  taskId: string;
  agentSessionId: string;
  /** Logical channel of the chunk. */
  kind:
    | 'prompt'
    | 'system'
    | 'assistant'
    | 'tool_use'
    | 'delegation'
    | 'tool_result'
    | 'result'
    | 'stderr';
  /** Rendered text for display. */
  text: string;
  /** Attachment filenames sent with a `prompt` message (for inline thumbnails). */
  attachments?: string[];
  /** Monotonic sequence number within the session, for ordering. */
  seq: number;
  ts: string;
}

export interface TaskStatusEvent {
  taskId: string;
  status: TaskStatus;
  ts: string;
}

export interface AgentStatusEvent {
  taskId: string;
  agentSessionId: string;
  status: AgentSessionStatus;
  ts: string;
}

export interface ApprovalCreatedEvent {
  approval: ApprovalRequest;
}

export interface ApprovalResolvedEvent {
  approvalId: string;
  taskId: string;
  status: ApprovalStatus;
  ts: string;
}

export interface TaskUpsertedEvent {
  task: Task;
}
