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
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    });
    this.logger.log(`Task worker started (bullmq, concurrency=${concurrency})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

function jobIdFor(data: TaskJobData): string {
  // Follow-ups get unique ids; initial runs are deduped per task.
  // NB: BullMQ forbids ':' in custom job ids (it's the Redis key separator).
  return data.followUpPrompt ? `${data.taskId}-${Date.now()}` : data.taskId;
}
