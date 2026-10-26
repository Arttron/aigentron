import { dirname, resolve, sep } from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { GIT_CREDENTIALS, type GitCredentialsProvider } from '../projects/git-credentials.port';
import { runGit } from '../projects/git/git-runner';
import { RepoSyncService } from '../projects/git/repo-sync.service';
import { taskBranchFor, worktreePathFor, type ProjectContext } from '../projects/project-context';
import { ProjectsService } from '../projects/projects.service';

export interface Worktree {
  branch: string;
  worktreePath: string;
}

/** The parts of a project the worktree service needs. */
export type CheckoutTarget = Pick<ProjectContext, 'id' | 'slug' | 'repoPath' | 'git'>;

/**
 * Manages per-task git worktrees. Each task gets its own branch + worktree off
 * its PROJECT's checkout (`WORKTREES_ROOT/<slug>/<taskId>`) so parallel agents
 * never collide on the working tree. The agent process is confined (cwd) to this worktree.
 * The checkout itself is provisioned by RepoSyncService (clone / fetch, per-project lock, the project's
 * credentials per command — nothing is written into `.git/config`).
 */
@Injectable()
export class WorktreeService {
  private readonly logger = new Logger(WorktreeService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly repoSync: RepoSyncService,
    private readonly projects: ProjectsService,
    @Inject(GIT_CREDENTIALS) private readonly credentials: GitCredentialsProvider,
  ) {}

  private async git(cwd: string, args: string[], project?: CheckoutTarget): Promise<string> {
    // With agents on their own OS user (S-01) the checkouts belong to that user; root's git must not refuse them.
    const auth = project ? await this.credentials.authFor(project.git) : undefined;
    const { stdout } = await runGit(args, { cwd, auth, safeDirectory: Boolean(this.config.agentRunAs), timeoutMs: 120_000 });
    return stdout.trim();
  }

  /** Verify a project's checkout exists and is a git repository. */
  async assertRepo(repo: string): Promise<void> {
    try {
      await access(repo);
    } catch {
      throw new Error(`the project checkout does not exist: ${repo}`);
    }
    try {
      await this.git(repo, ['rev-parse', '--is-inside-work-tree']);
    } catch {
      throw new Error(`the project checkout is not a git repository: ${repo}`);
    }
  }

  /** Clone / fetch the project's checkout (serialised per project) and return its row for the base ref. */
  private async provision(project: CheckoutTarget) {
    const row = await this.projects.get(project.slug);
    await this.repoSync.ensure(row, { lenient: true });
    return row;
  }

  /** Create a fresh branch + worktree for a task of a project. Idempotent-ish: reuses path. */
  async createForTask(project: CheckoutTarget, taskId: string, title?: string | null): Promise<Worktree> {
    // Provision the project's checkout (clone/fetch or git init) before branching off it.
    const row = await this.provision(project);
    const repo = project.repoPath;
    const branch = taskBranchFor(taskId, title);
    const worktreePath = worktreePathFor(this.config.worktreesRoot, project.slug, taskId);
    await mkdir(dirname(worktreePath), { recursive: true });

    // Base the branch on the freshest source ref (origin/<branch> or HEAD).
    const baseRef = await this.repoSync.baseRef(row);
    await this.git(repo, ['worktree', 'add', '-b', branch, worktreePath, baseRef], project);
    this.logger.log(`[${project.slug}] Created worktree ${worktreePath} on branch ${branch} (base ${baseRef})`);
    return { branch, worktreePath };
  }

  /**
   * Shared mode: the project's tasks run in its checkout (no per-task
   * branch/worktree). Returns the repo path + its current branch.
   */
  async useSharedRepo(project: CheckoutTarget): Promise<Worktree> {
    await this.provision(project);
    const repo = project.repoPath;
    const branch = await this.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'main');
    return { branch, worktreePath: repo };
  }

  /** Is this path a per-task worktree (under WORKTREES_ROOT) — as opposed to a project's checkout or a docs folder? */
  isTaskWorktree(worktreePath: string): boolean {
    const root = resolve(this.config.worktreesRoot);
    const p = resolve(worktreePath);
    return p !== root && p.startsWith(root + sep);
  }

  /** The main checkout a worktree belongs to (its `.git` common dir's parent); null when it cannot be told. */
  private async mainRepoOf(worktreePath: string): Promise<string | null> {
    try {
      const common = await this.git(worktreePath, ['rev-parse', '--git-common-dir']); // absolute or relative to the cwd, by git version
      return common ? dirname(resolve(worktreePath, common)) : null;
    } catch {
      return null;
    }
  }

  /** Full cleanup for a deleted task: drop the worktree and its branch. Never touches a project checkout (shared mode points tasks at it directly). */
  async cleanup(branch: string | null, worktreePath: string | null): Promise<void> {
    if (!worktreePath || !this.isTaskWorktree(worktreePath)) return;
    const repo = await this.mainRepoOf(worktreePath);
    await this.remove(worktreePath, repo ?? undefined);
    if (branch && repo) {
      await this.git(repo, ['branch', '-D', branch]).catch((err) =>
        this.logger.warn(`Failed to delete branch ${branch}: ${(err as Error).message}`),
      );
    }
  }

  /** Remove a task's worktree. Branch is kept so its commits remain inspectable. */
  async remove(worktreePath: string, repo?: string): Promise<void> {
    const from = repo ?? (await this.mainRepoOf(worktreePath)) ?? this.config.workspaceRepoPath;
    try {
      await this.git(from, ['worktree', 'remove', '--force', worktreePath]);
      this.logger.log(`Removed worktree ${worktreePath}`);
    } catch (err) {
      this.logger.warn(`Failed to remove worktree ${worktreePath}: ${(err as Error).message}`);
    }
  }
}
