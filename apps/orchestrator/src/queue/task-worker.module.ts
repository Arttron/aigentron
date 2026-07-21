import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { WorktreeModule } from '../worktrees/worktree.module';
import { AgentModule } from '../agent/agent.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { QueueProducerModule } from './queue-producer.module';
import { TaskWorkerService } from './task-worker.service';
import { VerificationService } from './verification.service';

@Module({
  imports: [TasksModule, WorktreeModule, AgentModule, ApprovalsModule, QueueProducerModule],
  providers: [TaskWorkerService, VerificationService],
})
export class TaskWorkerModule {}
