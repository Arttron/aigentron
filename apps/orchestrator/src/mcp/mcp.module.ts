import { Global, Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

/** Global so the executor can resolve an agent's MCP servers at spawn time. */
@Global()
@Module({
  controllers: [McpController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
