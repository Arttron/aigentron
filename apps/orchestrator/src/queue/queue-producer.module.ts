import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CONNECTION } from '../redis/redis.module';
import { TaskQueue } from './queue.constants';
import { BullTaskQueue } from './bull-task-queue.service';
import { EmbeddedTaskQueue } from './embedded-task-queue.service';

/**
 * Producer-only module. Kept separate from the worker so feature modules can
 * enqueue jobs without importing the worker (which itself depends on them).
 * Provides the TaskQueue driver picked by profile: BullMQ when REDIS_URL is
 * set, the embedded in-process poller otherwise.
 */
@Module({
  providers: [
    {
      provide: TaskQueue,
      inject: [AppConfigService, PrismaService, REDIS_CONNECTION],
      // Nest runs lifecycle hooks (onModuleInit/Destroy) on factory-provided
      // instances, so the drivers' own hooks fire normally.
      useFactory: (config: AppConfigService, prisma: PrismaService, redis: unknown) =>
        config.queueDriver === 'bullmq'
          ? new BullTaskQueue(redis as never)
          : new EmbeddedTaskQueue(prisma),
    },
  ],
  exports: [TaskQueue],
})
export class QueueProducerModule {}
