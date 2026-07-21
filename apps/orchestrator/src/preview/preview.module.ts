import { Global, Module } from '@nestjs/common';
import { PreviewService } from './preview.service';

/** Ephemeral per-task worktree preview servers (for the browser MCP). */
@Global()
@Module({
  providers: [PreviewService],
  exports: [PreviewService],
})
export class PreviewModule {}
