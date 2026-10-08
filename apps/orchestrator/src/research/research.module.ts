import { Module } from '@nestjs/common';
import { ResearchController } from './research.controller';
import { ResearchMcpService } from './research-mcp.service';
import { ResearchService } from './research.service';

@Module({
  controllers: [ResearchController],
  providers: [ResearchService, ResearchMcpService],
  exports: [ResearchService],
})
export class ResearchModule {}
