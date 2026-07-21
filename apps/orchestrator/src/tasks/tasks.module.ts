import { Module } from '@nestjs/common';
import { QueueProducerModule } from '../queue/queue-producer.module';
import { WorktreeModule } from '../worktrees/worktree.module';
import { AgentModule } from '../agent/agent.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [QueueProducerModule, WorktreeModule, AgentModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
