import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { HookSecretGuard } from './hook-secret.guard';
import { SecretLinksService } from './secret-links.service';
import { SecretLinksController } from './secret-links.controller';

@Module({
  imports: [TasksModule],
  controllers: [ApprovalsController, SecretLinksController],
  providers: [ApprovalsService, HookSecretGuard, SecretLinksService],
  exports: [ApprovalsService, SecretLinksService],
})
export class ApprovalsModule {}
