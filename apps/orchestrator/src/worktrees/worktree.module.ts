import { Module } from '@nestjs/common';
import { WorktreeService } from './worktree.service';
import { WorkspaceService } from './workspace.service';
import { GitHubService } from './github.service';

@Module({
  providers: [WorktreeService, WorkspaceService, GitHubService],
  exports: [WorktreeService, WorkspaceService, GitHubService],
})
export class WorktreeModule {}
