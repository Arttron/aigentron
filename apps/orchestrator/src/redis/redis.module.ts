import { Global, Module, type Provider } from '@nestjs/common';
import IORedis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';

export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');

const redisProvider: Provider = {
  provide: REDIS_CONNECTION,
  inject: [AppConfigService],
  // Embedded queue driver (REDIS_URL unset) → no Redis in the deployment at
  // all: provide null instead of a connection that would retry forever.
  useFactory: (config: AppConfigService): IORedis | null =>
    config.queueDriver === 'bullmq'
      ? // BullMQ requires maxRetriesPerRequest: null on the shared connection.
        new IORedis(config.redisUrl, { maxRetriesPerRequest: null })
      : null,
};

@Global()
@Module({
  providers: [redisProvider],
  exports: [REDIS_CONNECTION],
})
export class RedisModule {}
