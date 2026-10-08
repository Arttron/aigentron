import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ChannelsModule } from '../channels/channels.module';
import { AgentRegistryModule } from '../agent-registry/agent-registry.module';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

@Module({
  imports: [TasksModule, ChannelsModule, AgentRegistryModule],
  controllers: [SchedulesController],
  providers: [SchedulesService],
  exports: [SchedulesService],
})
export class SchedulesModule {}
