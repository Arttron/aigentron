/**
 * Clone / fetch a project's repository into its checkout (`ProjectsService.repoPathOf`), with the project's own
 * credentials (GitAccessService.authFor) — serialised per project so two tasks never clone at once.
 *
 * This is the project-aware twin of worktrees/workspace.service.ts' `provision()`: the runtime (stream A) calls
 * `ensure(project)` before it creates a worktree / starts a shared-mode run; the API's POST …/repo/sync calls it on
 * demand. No credential is persisted into the checkout (`.git/config` stays clean): pushes go through the
 * orchestrator with `authFor`, agents never hold the token or the key.
 */
import { mkdir } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { parseRepoUrl } from '../project-core';
import { ProjectsService, type ProjectRow } from '../projects.service';
import { GitAccessService } from './git-access.service';
import { runGit } from './git-runner';

export interface RepoSyncResult {
  action: 'cloned' | 'fetched' | 'initialized' | 'unchanged' | 'skipped';
  path: string;
  branch: string;
  /** sha of origin/<branch> (or HEAD for a local repo) after the sync, when known */
  head: string | null;
  durationMs: number;
  detail: string;
}

const CLONE_TIMEOUT_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 10 * 60_000;

@Injectable()
export class RepoSyncService {
  private readonly logger = new Logger(RepoSyncService.name);
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: AppConfigService,
    private readonly projects: ProjectsService,
    private readonly access: GitAccessService,
  ) {}

  /** Make the project's checkout exist and be current. One sync per project at a time; others wait for it. */
  /**
   * `lenient` (task runs): a failed FETCH of an existing checkout is logged loudly and the run goes on from the last fetched state, as it
   * always did (a bad token or a network blip must not fail every task); a failed first CLONE still throws. The API's explicit "Sync now" is strict.
   */
  async ensure(projectOrSlug: ProjectRow | string, opts: { lenient?: boolean } = {}): Promise<RepoSyncResult> {
    const p = typeof projectOrSlug === 'string' ? await this.projects.get(projectOrSlug) : projectOrSlug;
    const prev = this.locks.get(p.id) ?? Promise.resolve();
    const run = prev.then(() => this.provision(p, opts.lenient === true));
    this.locks.set(p.id, run.catch(() => undefined));
    try {
      return await run;
    } finally {
      if (this.locks.get(p.id) === run) this.locks.delete(p.id);
    }
  }

  /** Base ref for a new worktree of the project: origin/<branch> when it exists, else HEAD. */
  async baseRef(p: ProjectRow): Promise<string> {
    const repo = this.projects.repoPathOf(p);
    if (p.repoUrl) {
      const ok = await runGit(['rev-parse', '--verify', '--quiet', `origin/${p.repoBranch}`], { cwd: repo, safeDirectory: this.safeDir, timeoutMs: 10_000 }).then(() => true, () => false);
      if (ok) return `origin/${p.repoBranch}`;
    }
    return 'HEAD';
  }

  private get safeDir(): boolean {
    return Boolean(this.config.agentRunAs);
  }

  private async provision(p: ProjectRow, lenient = false): Promise<RepoSyncResult> {
    const started = Date.now();
    const repo = this.projects.repoPathOf(p);
    const done = (action: RepoSyncResult['action'], head: string | null, detail: string): RepoSyncResult => ({ action, path: repo, branch: p.repoBranch, head, durationMs: Date.now() - started, detail });
    if (p.kind !== 'code') return done('skipped', null, `a ${p.kind} project has no git checkout`);
    await mkdir(repo, { recursive: true });
    const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: repo, safeDirectory: this.safeDir, timeoutMs: 10_000 }).then(() => true, () => false);

    if (p.repoUrl) {
      const parsed = parseRepoUrl(p.repoUrl);
      if (!parsed) throw new Error(`project "${p.slug}": the repository URL is not valid`);
      const auth = await this.access.authFor(p);
      const url = parsed.url;
      if (isRepo) {
        await this.setOrigin(repo, url);
        this.logger.log(`project "${p.slug}": fetching origin/${p.repoBranch}`);
        try {
          await runGit(['fetch', '--prune', 'origin', p.repoBranch], { cwd: repo, auth, safeDirectory: this.safeDir, timeoutMs: FETCH_TIMEOUT_MS });
        } catch (err) {
          if (!lenient) throw err;
          const why = auth.redact((err as Error).message).split('\n')[0]!.slice(0, 200);
          this.logger.error(`project "${p.slug}": fetch of origin/${p.repoBranch} failed — the run continues on the last fetched state (new worktrees may be based on a stale ${p.repoBranch}): ${why}`);
          return done('unchanged', await this.sha(repo, 'HEAD'), `fetch failed, using the last fetched state: ${why}`);
        }
        return done('fetched', await this.sha(repo, `origin/${p.repoBranch}`), `fetched origin/${p.repoBranch}`);
      }
      this.logger.log(`project "${p.slug}": cloning ${url} (${p.repoBranch}) into ${repo}`);
      await runGit(['clone', '--branch', p.repoBranch, url, '.'], { cwd: repo, auth, safeDirectory: this.safeDir, timeoutMs: CLONE_TIMEOUT_MS });
      return done('cloned', await this.sha(repo, 'HEAD'), `cloned ${url} (${p.repoBranch})`);
    }

    if (isRepo) return done('unchanged', await this.sha(repo, 'HEAD'), 'local repository, no remote configured');
    this.logger.log(`project "${p.slug}": initialising a local repository at ${repo}`);
    await runGit(['init', '-q', '-b', p.repoBranch], { cwd: repo, timeoutMs: 10_000 });
    await runGit(['-c', 'user.email=agent@aigentron.local', '-c', 'user.name=Aigentron', 'commit', '-q', '--allow-empty', '-m', 'chore: initialize project repository'], { cwd: repo, timeoutMs: 10_000 });
    return done('initialized', await this.sha(repo, 'HEAD'), 'initialised an empty local repository (no remote)');
  }

  private async setOrigin(repo: string, url: string): Promise<void> {
    const remotes = await runGit(['remote'], { cwd: repo, safeDirectory: this.safeDir, timeoutMs: 10_000 }).then((r) => r.stdout, () => '');
    const args = remotes.split('\n').includes('origin') ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url];
    await runGit(args, { cwd: repo, safeDirectory: this.safeDir, timeoutMs: 10_000 });
  }

  private sha(repo: string, ref: string): Promise<string | null> {
    return runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: repo, safeDirectory: this.safeDir, timeoutMs: 10_000 }).then((r) => r.stdout.trim() || null, () => null);
  }
}
