import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TaskQueue, type TaskJobData, type TaskJobProcessor } from './queue.constants';

/** How often the worker looks for due jobs. Local DB — a cheap indexed query. */
const POLL_MS = 1000;

/**
 * Redis-less driver — the `minimal`/single-container profile. Jobs live in the
 * QueueJob table; a single in-process poll loop claims due rows up to the
 * concurrency cap. One attempt per job: a claimed row is deleted when its run
 * settles (success OR error — the task's status carries the outcome); rows
 * still claimed at worker start belonged to a crashed process and are deleted
 * (the orphan reconcile stalls their tasks, same as the BullMQ path).
 */
@Injectable()
export class EmbeddedTaskQueue extends TaskQueue implements OnModuleDestroy {
  private readonly logger = new Logger(EmbeddedTaskQueue.name);
  private timer?: NodeJS.Timeout;
  private processor?: TaskJobProcessor;
  private concurrency = 1;
  private inFlight = 0;
  private stopped = false;

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async enqueue(data: TaskJobData, opts?: { delayMs?: number }): Promise<void> {
    const dedupKey = data.followUpPrompt ? null : data.taskId;
    if (dedupKey) {
      // Initial runs dedup per task (same as the BullMQ jobId). Single-process
      // driver → a read-then-insert is race-safe enough.
      const dup = await this.prisma.queueJob.findFirst({
        where: { dedupKey, claimedAt: null },
        select: { id: true },
      });
      if (dup) return;
    }
    await this.prisma.queueJob.create({
      data: {
        taskId: data.taskId,
        payload: JSON.stringify(data),
        dedupKey,
        runAfter: new Date(Date.now() + (opts?.delayMs ?? 0)),
      },
    });
    const when = opts?.delayMs ? ` (in ${Math.round(opts.delayMs / 1000)}s)` : '';
    this.logger.log(`Enqueued task ${data.taskId}${data.followUpPrompt ? ' (follow-up)' : ''}${when}`);
    // No artificial latency when idle: try to pick it up right away.
    setImmediate(() => void this.tick());
  }

  async removeForTask(taskId: string): Promise<void> {
    await this.prisma.queueJob.deleteMany({ where: { taskId, claimedAt: null } });
  }

  async startWorker(processor: TaskJobProcessor, concurrency: number): Promise<void> {
    this.processor = processor;
    this.concurrency = Math.max(1, concurrency);
    // Claims held by a previous (crashed) process: those runs are gone; drop the
    // rows. Their tasks were just reconciled running→stalled by the caller.
    const stale = await this.prisma.queueJob.deleteMany({ where: { claimedAt: { not: null } } });
    if (stale.count) this.logger.warn(`Dropped ${stale.count} job(s) claimed by a previous process`);
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.logger.log(`Task worker started (embedded, concurrency=${this.concurrency})`);
  }

  /** Claim due jobs up to the concurrency cap and run them. */
  private async tick(): Promise<void> {
    if (!this.processor || this.stopped) return;
    while (this.inFlight < this.concurrency) {
      const job = await this.claimNext();
      if (!job) return;
      this.inFlight++;
      void this.run(job).finally(() => {
        this.inFlight--;
        // A slot just freed — a queued job may be due; don't wait for the poll.
        if (!this.stopped) setImmediate(() => void this.tick());
      });
    }
  }

  /** Atomically claim the oldest due job (updateMany count acts as the lock). */
  private async claimNext(): Promise<{ id: string; payload: string } | null> {
    const due = await this.prisma.queueJob.findFirst({
      where: { claimedAt: null, runAfter: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, payload: true },
    });
    if (!due) return null;
    const claimed = await this.prisma.queueJob.updateMany({
      where: { id: due.id, claimedAt: null },
      data: { claimedAt: new Date() },
    });
    return claimed.count === 1 ? due : this.claimNext(); // lost the (theoretical) race — next
  }

  private async run(job: { id: string; payload: string }): Promise<void> {
    let data: TaskJobData;
    try {
      data = JSON.parse(job.payload) as TaskJobData;
    } catch {
      this.logger.error(`Job ${job.id}: unparseable payload — dropping`);
      await this.prisma.queueJob.delete({ where: { id: job.id } }).catch(() => undefined);
      return;
    }
    try {
      await this.processor!(data);
    } catch (err) {
      // One-attempt semantics: the failure is recorded on the task by the
      // processor itself; the job is spent either way.
      this.logger.error(`Job ${job.id} (task ${data.taskId}) failed: ${(err as Error).message}`);
    } finally {
      await this.prisma.queueJob.delete({ where: { id: job.id } }).catch(() => undefined);
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
