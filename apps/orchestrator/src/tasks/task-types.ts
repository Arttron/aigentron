/** Task types for the list filter: mutually exclusive, decided by kind > parent > origin > agent. */
export const TASK_TYPES = ['task', 'subtask', 'chat', 'scheduled', 'channel', 'discussion'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const isTaskType = (v: unknown): v is TaskType => typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v);

/**
 * Prisma `where` for one type. `chatAgents` = names of conversational agents (mode: chat, e.g. the admin).
 *  - discussion: a round-table between agents
 *  - subtask:    produced by a lead's decomposition (has a parent)
 *  - scheduled:  started by a schedule
 *  - channel:    started from a chat channel (Telegram …)
 *  - chat:       a conversation with a chat-mode agent
 *  - task:       everything else (started in the dashboard / API)
 */
export function typeWhere(type: TaskType, chatAgents: readonly string[]): Record<string, unknown> {
  const top = { kind: 'task', parentId: null };
  switch (type) {
    case 'discussion':
      return { kind: 'discussion' };
    case 'subtask':
      return { kind: 'task', parentId: { not: null } };
    case 'scheduled':
      return { ...top, createdByChannel: { startsWith: 'schedule:' } };
    case 'channel':
      return { ...top, AND: [{ createdByChannel: { not: null } }, { NOT: { createdByChannel: { startsWith: 'schedule:' } } }] };
    case 'chat':
      return { ...top, createdByChannel: null, agentName: { in: [...chatAgents] } };
    case 'task':
      return { ...top, createdByChannel: null, OR: [{ agentName: null }, { agentName: { notIn: [...chatAgents] } }] };
  }
}
