import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { REDIS_CONNECTION } from '../redis/redis.module';
import { TASK_QUEUE, TaskQueue, type TaskJobData, type TaskJobProcessor } from './queue.constants';

/**
 * BullMQ/Redis driver — the `full` profile. Producer is created eagerly; the
 * worker only when the worker module calls startWorker (feature modules can
 * enqueue without pulling the worker in).
 */
@Injectable()
export class BullTaskQueue extends TaskQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BullTaskQueue.name);
  private queue!: Queue<TaskJobData>;
  private worker?: Worker<TaskJobData>;

  constructor(@Optional() @Inject(REDIS_CONNECTION) private readonly connection: IORedis | null) {
    super();
  }

  onModuleInit(): void {
    if (!this.connection) throw new Error('BullTaskQueue requires a Redis connection (REDIS_URL)');
    this.queue = new Queue<TaskJobData>(TASK_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 1, // agent runs are not idempotent; do not auto-retry
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
    // Without a listener BullMQ re-emits connection errors as 'error' on an
    // EventEmitter with no handler → an uncaught exception ends the process.
    // A Redis blip must only be logged; BullMQ reconnects by itself.
    this.queue.on('error', (err) => this.logger.error(`Queue error (Redis): ${err.message}`));
  }

  async enqueue(data: TaskJobData, opts?: { delayMs?: number }): Promise<void> {
    await this.queue.add('run', data, { jobId: jobIdFor(data), delay: opts?.delayMs });
    const when = opts?.delayMs ? ` (in ${Math.round(opts.delayMs / 1000)}s)` : '';
    this.logger.log(`Enqueued task ${data.taskId}${data.followUpPrompt ? ' (follow-up)' : ''}${when}`);
  }

  async removeForTask(taskId: string): Promise<void> {
    const jobs = await this.queue.getJobs(['waiting', 'delayed', 'prioritized', 'paused']);
    await Promise.all(
      jobs
        .filter((job) => job?.data?.taskId === taskId)
        .map((job) => job.remove().catch(() => undefined)),
    );
  }

  async startWorker(processor: TaskJobProcessor, concurrency: number): Promise<void> {
    this.worker = new Worker<TaskJobData>(TASK_QUEUE, (job) => processor(job.data), {
      connection: this.connection!,
      concurrency,
      // One attempt per job (queue.constants.ts): a job whose process died must NOT be
      // handed back to the queue — it would restart the task from its original prompt
      // in a dirty worktree. BullMQ's default (1) does exactly that; 0 fails it instead,
      // and the orphan reconcile marks the task `stalled` (X-Q-4).
      maxStalledCount: 0,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    });
    // Same as for the queue: an unhandled 'error' (lost Redis, a lock renewal
    // that failed) would take the whole orchestrator down with the agents.
    this.worker.on('error', (err) => this.logger.error(`Worker error (Redis): ${err.message}`));
    this.logger.log(`Task worker started (bullmq, concurrency=${concurrency})`);
  }

  setConcurrency(concurrency: number): void {
    // BullMQ's Worker applies a reassigned `.concurrency` to future dispatch
    // without needing a restart. No-op if the worker hasn't started yet —
    // startWorker's own initial value already covers that case.
    if (this.worker) this.worker.concurrency = concurrency;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

/** Follow-ups get unique ids (two in one millisecond — a drain and a scheduled re-check — must not
 *  dedupe into one, E-32); initial runs are deduped per task.
 *  NB: BullMQ forbids ':' in custom job ids (it's the Redis key separator). */
export function jobIdFor(data: TaskJobData): string {
  return data.followUpPrompt ? `${data.taskId}-${randomUUID()}` : data.taskId;
}
