import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ChannelsService } from './channels.service';
import { ChannelManagerService } from './channel-manager.service';
import { ChannelCommandService } from './channel-commands.service';
import { ChannelsController } from './channels.controller';
import { PairingService } from './pairing.service';

/**
 * External communication channels (Telegram first): CRUD + a runtime manager
 * that long-polls for inbound messages and forwards outbound task/approval
 * updates to the owning conversation.
 */
@Module({
  imports: [TasksModule, ApprovalsModule],
  controllers: [ChannelsController],
  providers: [ChannelsService, ChannelManagerService, ChannelCommandService, PairingService],
  exports: [ChannelsService, ChannelManagerService, PairingService],
})
export class ChannelsModule {}
