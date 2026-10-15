import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SettingsService, type WorkspaceConfig } from '../settings/settings.service';
import { gitAuthEnv, redactUrl } from './git-auth';

const exec = promisify(execFile);

/**
 * Provisions the shared workspace repo at WORKSPACE_REPO_PATH:
 *   - repoUrl set  -> clone it (or fetch if already cloned); branches base on
 *                     the freshest origin/<branch>.
 *   - repoUrl empty -> git init a local repo (with a HEAD) so the worktree
 *                     isolation model still works; no remote, no push.
 *
 * The GitHub token is passed per-command via `http.extraHeader` so it is never
 * written into the on-disk remote URL or git config.
 */
@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);
  // Serialize provisioning so concurrent tasks don't clone/fetch at once.
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: AppConfigService,
    private readonly settings: SettingsService,
  ) {}

  private async git(cwd: string, args: string[], cfg?: WorkspaceConfig): Promise<string> {
    // With agents on their own OS user (S-01) the repo belongs to that user; root's git must not refuse it.
    const safe = this.config.agentRunAs ? ['-c', 'safe.directory=*'] : [];
    const { stdout } = await exec('git', [...safe, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: gitAuthEnv(cfg?.githubToken),
    });
    return stdout.trim();
  }

  private async isRepo(dir: string): Promise<boolean> {
    try {
      await this.git(dir, ['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  /** Ensure the workspace exists and is up to date. Serialized across tasks. */
  async ensure(): Promise<void> {
    const run = this.lock.then(() => this.provision());
    this.lock = run.catch(() => undefined); // keep the chain alive on failure
    await run;
  }

  private async provision(): Promise<void> {
    const repo = this.config.workspaceRepoPath;
    const cfg = await this.settings.workspaceConfig();
    await mkdir(repo, { recursive: true });

    const repoUrl = cfg.repoUrl;
    if (repoUrl) {
      if (await this.isRepo(repo)) {
        await this.setOrigin(repo, repoUrl); // handles init'd-then-configured
        this.logger.log(`Fetching origin/${cfg.repoBranch}`);
        // Not fatal (the task still runs on what is checked out), but loud: every
        // worktree created until the next successful fetch is based on a STALE
        // origin/<branch>, and the usual cause (a bad token, no network) needs a person.
        await this.git(repo, ['fetch', '--prune', 'origin', cfg.repoBranch], cfg).catch((err) =>
          this.logger.error(
            `fetch of origin/${cfg.repoBranch} from ${redactUrl(repoUrl)} failed — new worktrees will base on the last fetched state until this is fixed: ${(err as Error).message}`,
          ),
        );
      } else {
        this.logger.log(`Cloning ${redactUrl(repoUrl)} (${cfg.repoBranch}) into workspace`);
        await this.git(repo, ['clone', '--branch', cfg.repoBranch, repoUrl, '.'], cfg);
      }
      // Persist the token as a git credential in the repo config so `git push`
      // works for the AGENT too (its own git reads this), without putting the raw
      // token in the agent's environment. Token lives in .git/config on disk.
      await this.configureCredential(repo, cfg.githubToken);
      return;
    }

    // No repo configured: make sure a local git repo with a HEAD exists.
    if (!(await this.isRepo(repo))) {
      this.logger.log(`Initializing local workspace repo at ${repo}`);
      await this.git(repo, ['init', '-b', cfg.repoBranch]);
      await this.git(repo, [
        '-c',
        'user.email=agent@local-dev-server',
        '-c',
        'user.name=LDS Agent',
        'commit',
        '--allow-empty',
        '-m',
        'chore: initialize workspace',
      ]);
    }
  }

  /**
   * Persist (or clear) the GitHub token as an http.extraHeader in the repo's
   * local git config, so any git over https to the remote authenticates —
   * including the agent's own `git push`. The token is base64 in .git/config;
   * cleared when no token is configured.
   */
  private async configureCredential(repo: string, token: string | null): Promise<void> {
    if (token) {
      const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
      await this.git(repo, ['config', 'http.extraHeader', `AUTHORIZATION: Basic ${basic}`]).catch(
        (err) => this.logger.warn(`could not set git credential: ${(err as Error).message}`),
      );
    } else {
      await this.git(repo, ['config', '--unset-all', 'http.extraHeader']).catch(() => undefined);
    }
  }

  /** Point `origin` at the configured URL (token travels via extraHeader). */
  private async setOrigin(repo: string, url: string): Promise<void> {
    const remotes = await this.git(repo, ['remote']).catch(() => '');
    if (remotes.split('\n').includes('origin')) {
      await this.git(repo, ['remote', 'set-url', 'origin', url]);
    } else {
      await this.git(repo, ['remote', 'add', 'origin', url]);
    }
  }

  /** Base ref for a new task worktree: latest remote branch, else local HEAD. */
  async baseRef(): Promise<string> {
    const repo = this.config.workspaceRepoPath;
    const cfg = await this.settings.workspaceConfig();
    if (cfg.repoUrl) {
      try {
        await this.git(repo, ['rev-parse', '--verify', `origin/${cfg.repoBranch}`]);
        return `origin/${cfg.repoBranch}`;
      } catch {
        // remote branch not found — fall back to HEAD
      }
    }
    return 'HEAD';
  }
}
