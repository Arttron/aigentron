import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { HookSecretGuard } from './hook-secret.guard';

@Module({
  imports: [TasksModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService, HookSecretGuard],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
