import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AppConfigModule } from './config/config.module';
import { PreflightModule } from './preflight/preflight.module';
import { PrismaModule } from './prisma/prisma.module';
import { BusModule } from './bus/bus.module';
import { RedisModule } from './redis/redis.module';
import { TasksModule } from './tasks/tasks.module';
import { TaskWorkerModule } from './queue/task-worker.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { QuestionsModule } from './questions/questions.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { DiscussionModule } from './discussion/discussion.module';
import { TitlesModule } from './titles/titles.module';
import { SettingsModule } from './settings/settings.module';
import { UsersModule } from './users/users.module';
import { AgentRegistryModule } from './agent-registry/agent-registry.module';
import { SkillConsolidationModule } from './agent-registry/skill-consolidation.module';
import { ProvidersModule } from './providers/providers.module';
import { McpModule } from './mcp/mcp.module';
import { McpHostModule } from './mcp-host/mcp-host.module';
import { InternalMcpModule } from './internal-mcp/internal-mcp.module';
import { CodexModule } from './codex/codex.module';
import { ResearchModule } from './research/research.module';
import { SecurityModule } from './security/security.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { LitellmModule } from './litellm/litellm.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { PreviewModule } from './preview/preview.module';
import { PresenceModule } from './presence/presence.service';
import { ChannelsModule } from './channels/channels.module';
import { EventsModule } from './events/events.module';
import { AuthModule } from './auth/auth.module';
import { AccessModule } from './access/access.module';
import { WebServerModule } from './web/web-server.module';
import { UpdateModule } from './update/update.module';
import { MediaModule } from './media/media.module';
import { SchedulesModule } from './schedules/schedules.module';
import { ResourcesModule } from './resources/resources.module';
import { PacksModule } from './packs/packs.module';
import { VoiceModule } from './voice/voice.module';
import { StatsModule } from './stats/stats.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    // Serves the dashboard SPA build same-origin. `exclude` keeps every
    // /api/* route (the global prefix set in main.ts) reaching its controller
    // instead of the static handler; unmatched non-API GETs fall back to
    // index.html so client-side routes (e.g. /tasks/:id) survive a refresh.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'dashboard', 'dist'),
      exclude: ['/api/*splat'],
    }),
    AppConfigModule,
    AuthModule,
    AccessModule,
    WebServerModule,
    UpdateModule,
    MediaModule,
    SchedulesModule,
    ResourcesModule,
    PacksModule,
    VoiceModule,
    PreflightModule,
    PrismaModule,
    BusModule,
    RedisModule,
    TasksModule,
    TaskWorkerModule,
    ApprovalsModule,
    QuestionsModule,
    KnowledgeModule,
    DiscussionModule,
    TitlesModule,
    SettingsModule,
    UsersModule,
    AgentRegistryModule,
    SkillConsolidationModule,
    ProvidersModule,
    McpModule,
    McpHostModule,
    InternalMcpModule,
    CodexModule,
    ResearchModule,
    SecurityModule,
    MaintenanceModule,
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
