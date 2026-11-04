/**
 * Why a queued task has not started yet, while the worker holds it back for the machine (load, memory, CPU steal) or for its turn
 * (runs start one at a time). In memory: it describes the next few seconds or minutes, not history; the dashboard shows it on a
 * `queued` task so a wait does not look like a hang.
 */
export interface StartHold {
  reason: string;
  /** ISO time the wait began */
  since: string;
  /** `start`: the task itself waits to start; `command`: a running task waits for a heavy command's turn in the pipeline */
  kind?: 'start' | 'command';
}

const holds = new Map<string, StartHold>();

export function setHold(taskId: string, reason: string, kind: 'start' | 'command' = 'start'): void {
  const prev = holds.get(taskId);
  holds.set(taskId, { reason, since: prev?.since ?? new Date().toISOString(), kind });
}

export const clearHold = (taskId: string): void => void holds.delete(taskId);

export const getHold = (taskId: string): StartHold | null => holds.get(taskId) ?? null;
