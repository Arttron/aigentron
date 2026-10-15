/**
 * Where an inbound chat message goes — one decision table for plain text, addressed text (`/agent …`, `@agent …`) and files.
 * Pure: the manager gathers the facts (DB lookups) and this picks the target, so the order of precedence is tested as a table.
 *
 * Precedence for a plain message:
 *   1. `/agent text` / `@agent text` — that agent's own task in this chat, or a new task for it (quote and open question ignored);
 *   2. a slash command (`/tasks`, `/cancel`, …);
 *   3. an open question of the task the message speaks to (the quoted task, else the chat's active task): the text is the answer;
 *   4. a quoted (replied-to) message of a task: a follow-up to THAT task, which becomes the chat's active task;
 *   5. the chat's active task, when it still exists: a follow-up;
 *   6. otherwise a new task.
 */

export interface RoutingFacts {
  /** `/agent text` or `@agent text`, resolved by the command service (null = not addressed). */
  address?: { agent: string; rest: string } | null;
  /** The text is a slash command. */
  command?: boolean;
  /** The task that sent the quoted message, when it still exists. */
  quotedTaskId?: string | null;
  /** The chat's active task, when it still exists. */
  activeTask?: { id: string; agentName?: string | null } | null;
  /** The open question of the task the message speaks to (quoted ?? active) that this chat may answer. */
  openQuestion?: { id: string; taskId: string } | null;
}

export type RouteTarget =
  /** Just an agent name: the chat talks to this agent from now on. */
  | { kind: 'select-agent'; agent: string }
  | { kind: 'command' }
  | { kind: 'answer'; questionId: string; taskId: string }
  /** Continue a task. `switchTo`: the task differs from the chat's active one (a quoted message) — make it active. */
  | { kind: 'follow-up'; taskId: string; switchTo: boolean }
  /** Start a task (for `agent` when addressed, else the chat's default). */
  | { kind: 'new'; agent?: string };

export function resolveTarget(f: RoutingFacts): RouteTarget {
  if (f.address) {
    if (!f.address.rest) return { kind: 'select-agent', agent: f.address.agent };
    if (f.activeTask && f.activeTask.agentName === f.address.agent) return { kind: 'follow-up', taskId: f.activeTask.id, switchTo: false };
    return { kind: 'new', agent: f.address.agent };
  }
  if (f.command) return { kind: 'command' };
  if (f.openQuestion) return { kind: 'answer', questionId: f.openQuestion.id, taskId: f.openQuestion.taskId };
  if (f.quotedTaskId) return { kind: 'follow-up', taskId: f.quotedTaskId, switchTo: f.activeTask?.id !== f.quotedTaskId };
  if (f.activeTask) return { kind: 'follow-up', taskId: f.activeTask.id, switchTo: false };
  return { kind: 'new' };
}

/** The task a message speaks to before any question is considered: the quoted task wins over the active one. */
export function spokenToTask(f: Pick<RoutingFacts, 'quotedTaskId' | 'activeTask'>): string | null {
  return f.quotedTaskId ?? f.activeTask?.id ?? null;
}
