/** Name of the BullMQ queue carrying agent task jobs. */
export const TASK_QUEUE = 'agent-tasks';

/** Shape of a job payload on the task queue. */
export interface TaskJobData {
  taskId: string;
  /** Optional follow-up prompt to continue an existing agent session. */
  followUpPrompt?: string;
  /** Attachment filenames sent with this message (for the prompt event). */
  attachments?: string[];
}

/** The function the worker runs for each claimed job. */
export type TaskJobProcessor = (data: TaskJobData) => Promise<void>;

/**
 * Queue driver contract (also the Nest injection token). Two implementations,
 * selected by env (deploy profiles — docs/plan-single-container.md):
 *  - BullTaskQueue     — BullMQ on Redis (`REDIS_URL` set; the `full` profile)
 *  - EmbeddedTaskQueue — in-process poller over a DB table (`REDIS_URL` unset;
 *    the `minimal`/single-container profile)
 * Semantics both drivers must honor: one attempt per job (agent runs are not
 * idempotent — a job that dies with the process is dropped; its task is handled
 * by the orphan reconcile); initial runs dedup per task, follow-ups don't.
 */
export abstract class TaskQueue {
  abstract enqueue(data: TaskJobData, opts?: { delayMs?: number }): Promise<void>;
  /** Drop any not-yet-running jobs for a task (used on cancel). */
  abstract removeForTask(taskId: string): Promise<void>;
  /** Start consuming jobs with the given processor. Called once, by the worker module. */
  abstract startWorker(processor: TaskJobProcessor, concurrency: number): Promise<void>;
}
