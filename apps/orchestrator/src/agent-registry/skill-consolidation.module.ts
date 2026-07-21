import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { SkillConsolidationSchedulerService } from './skill-consolidation-scheduler.service';

/**
 * Separate leaf module (not folded into AgentRegistryModule/SettingsModule)
 * purely to keep this one explicit `imports: [TasksModule]` from raising any
 * question about module cycles — nothing depends on this module, so it can't
 * participate in one.
 */
@Module({
  imports: [TasksModule],
  providers: [SkillConsolidationSchedulerService],
})
export class SkillConsolidationModule {}
