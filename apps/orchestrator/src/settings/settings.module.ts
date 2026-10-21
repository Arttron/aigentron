import { Global, Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { RunLimitsController } from './run-limits.controller';
import { RunLimitsService } from './run-limits.service';

/** Global so the executor and approvals can read live routing/timeout config. */
@Global()
@Module({
  controllers: [SettingsController, RunLimitsController],
  providers: [SettingsService, RunLimitsService],
  exports: [SettingsService, RunLimitsService],
})
export class SettingsModule {}
