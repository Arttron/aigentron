import { Global, Module } from '@nestjs/common';
import { InternalMcpController } from './internal-mcp.controller';
import { InternalMcpService } from './internal-mcp.service';

/** Global so the agent executor can register runs without module wiring. */
@Global()
@Module({
  controllers: [InternalMcpController],
  providers: [InternalMcpService],
  exports: [InternalMcpService],
})
export class InternalMcpModule {}
