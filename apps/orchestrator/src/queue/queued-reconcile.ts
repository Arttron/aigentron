/**
 * A task is `queued` only while a job for it sits in the queue (or is being started). A restart, a crash or a lost Redis job can leave
 * the task `queued` with NO job — it then waits forever. This is the pure rule for what to do with such a task.
 */
export type QueuedFate = 'keep' | 'requeue' | 'stall';

/** `sessions` = how many agent runs the task has had. A task that never ran is simply queued again; one that ran lost a follow-up we cannot recreate. */
export function queuedFate(t: { hasJob: boolean; sessions: number }): QueuedFate {
  if (t.hasJob) return 'keep';
  return t.sessions === 0 ? 'requeue' : 'stall';
}

export const QUEUED_STALL_MESSAGE =
  'The server restarted (or the queue lost the job) while this message was waiting to run, so it was not started. Send it again or press Continue.';

/** How long a `queued` task may sit before the periodic sweep looks for a missing job (a project lock or a full queue legitimately take a while). */
export const QUEUED_SWEEP_AFTER_MS = 10 * 60_000;
export const QUEUED_SWEEP_EVERY_MS = 5 * 60_000;
