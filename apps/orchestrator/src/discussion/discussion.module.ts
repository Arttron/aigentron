import { Global, Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AgentRegistryModule } from '../agent-registry/agent-registry.module';
import { TasksModule } from '../tasks/tasks.module';
import { DiscussionController } from './discussion.controller';
import { DiscussionService } from './discussion.service';

@Global()
@Module({
  imports: [TasksModule, AgentModule, AgentRegistryModule],
  controllers: [DiscussionController],
  providers: [DiscussionService],
  exports: [DiscussionService],
})
export class DiscussionModule {}
