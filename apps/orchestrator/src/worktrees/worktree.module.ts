import { Module } from '@nestjs/common';
import { WorktreeService } from './worktree.service';
import { GitHubService } from './github.service';

/**
 * Git for a task's project: worktrees and publishing. The checkout itself (clone / fetch) and the credentials come
 * from the global GitAccessModule (RepoSyncService, GIT_CREDENTIALS) — NOT imported here on purpose: a module's own
 * provider would shadow the global one and make per-project tokens / SSH keys ineffective.
 */
@Module({
  providers: [WorktreeService, GitHubService],
  exports: [WorktreeService, GitHubService],
})
export class WorktreeModule {}
