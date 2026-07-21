import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigModule } from './config/config.module';
import { PreflightModule } from './preflight/preflight.module';
import { PrismaModule } from './prisma/prisma.module';
import { BusModule } from './bus/bus.module';
import { RedisModule } from './redis/redis.module';
import { TasksModule } from './tasks/tasks.module';
import { TaskWorkerModule } from './queue/task-worker.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { SettingsModule } from './settings/settings.module';
import { UsersModule } from './users/users.module';
import { AgentRegistryModule } from './agent-registry/agent-registry.module';
import { SkillConsolidationModule } from './agent-registry/skill-consolidation.module';
import { ProvidersModule } from './providers/providers.module';
import { McpModule } from './mcp/mcp.module';
import { McpHostModule } from './mcp-host/mcp-host.module';
import { LitellmModule } from './litellm/litellm.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { PreviewModule } from './preview/preview.module';
import { PresenceModule } from './presence/presence.service';
import { ChannelsModule } from './channels/channels.module';
import { EventsModule } from './events/events.module';
import { StatsModule } from './stats/stats.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    AppConfigModule,
    PreflightModule,
    PrismaModule,
    BusModule,
    RedisModule,
    TasksModule,
    TaskWorkerModule,
    ApprovalsModule,
    SettingsModule,
    UsersModule,
    AgentRegistryModule,
    SkillConsolidationModule,
    ProvidersModule,
    McpModule,
    McpHostModule,
    LitellmModule,
    AttachmentsModule,
    PreviewModule,
    PresenceModule,
    ChannelsModule,
    EventsModule,
    StatsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
