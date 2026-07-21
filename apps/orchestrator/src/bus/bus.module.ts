import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { REDIS_CONNECTION } from '../redis/redis.module';
import { AgentEventBus } from './agent-event-bus';
import { LocalEventBus } from './local-event-bus';

/**
 * Binds both event-bus drivers to the `AgentEventBus` token (docs/plan-single-
 * container.md), picked by the SAME signal as the queue driver: no REDIS_URL
 * means no Redis anywhere in this deployment, so the bus goes in-process too
 * (see LocalEventBus — not a degraded mode, the correct one for one process).
 * The Redis path (`useClass: AgentEventBus`, full profile) is untouched.
 */
@Global()
@Module({
  providers: [
    {
      provide: AgentEventBus,
      inject: [AppConfigService, REDIS_CONNECTION],
      // LocalEventBus exposes the same publish/subscribe surface the ~7
      // consumers use; the cast is the one place that substitution is explicit.
      useFactory: (config: AppConfigService, redis: unknown) =>
        (config.queueDriver === 'bullmq'
          ? new AgentEventBus(redis as never)
          : new LocalEventBus()) as AgentEventBus,
    },
  ],
  exports: [AgentEventBus],
})
export class BusModule {}
