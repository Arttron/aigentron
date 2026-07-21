import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { McpHostController } from './mcp-host.controller';
import { McpHostService } from './mcp-host.service';

/**
 * Hosts the Streamable-HTTP MCP server (`/api/mcp`) that lets external clients
 * drive the fleet. Thin adapter over TasksService; AgentEventBus + config are
 * global. Distinct from `McpModule` (which manages external MCP server configs
 * agents consume, at `/api/mcp-servers`).
 */
@Module({
  imports: [TasksModule, ApprovalsModule],
  controllers: [McpHostController],
  providers: [McpHostService],
})
export class McpHostModule {}
