import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { WorkspaceService } from './workspace.service';

const exec = promisify(execFile);

export interface Worktree {
  branch: string;
  worktreePath: string;
}

/**
 * Manages per-task git worktrees. Each task gets its own branch + worktree off
 * the shared workspace repo so parallel agents never collide on the working
 * tree. The agent process is confined (cwd) to this worktree.
 */
@Injectable()
export class WorktreeService {
  private readonly logger = new Logger(WorktreeService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly workspace: WorkspaceService,
  ) {}

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  }

  /** Verify the workspace repo exists and is a git repository. */
  async assertRepo(): Promise<void> {
    const repo = this.config.workspaceRepoPath;
    try {
      await access(repo);
    } catch {
      throw new Error(`WORKSPACE_REPO_PATH does not exist: ${repo}`);
    }
    try {
      await this.git(repo, ['rev-parse', '--is-inside-work-tree']);
    } catch {
      throw new Error(`WORKSPACE_REPO_PATH is not a git repository: ${repo}`);
    }
  }

  /** Create a fresh branch + worktree for a task. Idempotent-ish: reuses path. */
  async createForTask(taskId: string): Promise<Worktree> {
    // Provision the workspace (clone/fetch or git init) before branching off it.
    await this.workspace.ensure();
    const repo = this.config.workspaceRepoPath;
    const branch = `agent/task-${taskId}`;
    const worktreePath = join(this.config.worktreesRoot, taskId);

    // Base the branch on the freshest source ref (origin/<branch> or HEAD).
    const baseRef = await this.workspace.baseRef();
    await this.git(repo, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
    this.logger.log(`Created worktree ${worktreePath} on branch ${branch} (base ${baseRef})`);
    return { branch, worktreePath };
  }

  /**
   * Shared-workspace mode: all tasks run in the main repo dir (no per-task
   * branch/worktree). Returns the repo path + its current branch.
   */
  async useSharedRepo(): Promise<Worktree> {
    await this.workspace.ensure();
    const repo = this.config.workspaceRepoPath;
    const branch = await this.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'main');
    return { branch, worktreePath: repo };
  }

  /** Full cleanup for a deleted task: drop the worktree and its branch. */
  async cleanup(branch: string | null, worktreePath: string | null): Promise<void> {
    // Never remove the shared main repo (shared mode points tasks at it directly).
    if (worktreePath && worktreePath !== this.config.workspaceRepoPath) {
      await this.remove(worktreePath);
      if (branch) {
        const repo = this.config.workspaceRepoPath;
        await this.git(repo, ['branch', '-D', branch]).catch((err) =>
          this.logger.warn(`Failed to delete branch ${branch}: ${(err as Error).message}`),
        );
      }
    }
  }

  /** Remove a task's worktree. Branch is kept so its commits remain inspectable. */
  async remove(worktreePath: string): Promise<void> {
    const repo = this.config.workspaceRepoPath;
    try {
      await this.git(repo, ['worktree', 'remove', '--force', worktreePath]);
      this.logger.log(`Removed worktree ${worktreePath}`);
    } catch (err) {
      this.logger.warn(`Failed to remove worktree ${worktreePath}: ${(err as Error).message}`);
    }
  }
}
