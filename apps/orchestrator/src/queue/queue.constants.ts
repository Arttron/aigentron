/** Name of the BullMQ queue carrying agent task jobs. */
export const TASK_QUEUE = 'agent-tasks';
/** The reserved lane of conversational (chat-mode) agents, the built-in admin first: its own queue and its own slots, outside the Settings cap. */
export const CHAT_QUEUE = 'agent-tasks-chat';
/** How many chat turns run at once in the reserved lane. They are short, so a person talking to the admin never waits behind long task runs. */
export const CHAT_LANE_CONCURRENCY = 2;

/** Shape of a job payload on the task queue. */
export interface TaskJobData {
  taskId: string;
  /** Optional follow-up prompt to continue an existing agent session. */
  followUpPrompt?: string;
  /** Attachment filenames sent with this message (for the prompt event). */
  attachments?: string[];
  /** `chat` = a turn of a chat-mode agent: runs in the reserved lane, never behind the task runs that fill the Settings cap. */
  lane?: 'chat';
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
  /** Change the running worker's concurrency cap live (TaskWorkerService polls
   *  the Settings value and calls this on change — no restart needed). */
  abstract setConcurrency(concurrency: number): void;
}
