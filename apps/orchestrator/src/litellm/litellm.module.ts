import { Global, Module } from '@nestjs/common';
import { LitellmController } from './litellm.controller';
import { LitellmManagedService } from './litellm-managed.service';
import { LitellmService } from './litellm.service';

@Global()
@Module({
  controllers: [LitellmController],
  // LitellmManagedService is always instantiated but only acts when
  // AppConfigService.litellmManaged is set (Phase 3, docs/plan-single-
  // container.md) — harmless no-op otherwise (its onModuleInit checks first).
  providers: [LitellmService, LitellmManagedService],
  exports: [LitellmService],
})
export class LitellmModule {}
