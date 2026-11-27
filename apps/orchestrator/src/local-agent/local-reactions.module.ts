import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { TasksModule } from '../tasks/tasks.module';
import { LocalAgentModule } from './local-agent.module';
import { LocalReactionsService } from './local-reactions.service';

/** Reacts to what the local agents report (notices, commit proposals). Apart from LocalAgentModule so that the line does not depend on tasks and channels. */
@Module({
  imports: [LocalAgentModule, TasksModule, ChannelsModule],
  providers: [LocalReactionsService],
})
export class LocalReactionsModule {}
