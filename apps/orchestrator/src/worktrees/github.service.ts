import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SettingsService } from '../settings/settings.service';

const exec = promisify(execFile);

export interface PublishInput {
  branch: string;
  /** PR title (task title). */
  title: string;
  /** PR body (e.g. the task prompt). */
  body: string;
}

/**
 * Publishes an agent's result branch back to GitHub: pushes the branch and
 * opens (or finds) a pull request against the configured base branch.
 *
 * Best-effort: any failure (no token, no write access, network) is logged and
 * returns null — the task already succeeded locally, so we never fail it here.
 */
@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly settings: SettingsService,
  ) {}

  /** Push the branch and open/find a PR. Returns the PR URL, or null if skipped. */
  async publishResult(input: PublishInput): Promise<string | null> {
    const cfg = await this.settings.workspaceConfig();
    if (!cfg.repoUrl) return null; // no-repo mode — nothing to push to
    if (!cfg.githubToken) {
      this.logger.warn('Skipping push/PR: no GitHub token configured');
      return null;
    }
    const slug = parseRepo(cfg.repoUrl);
    if (!slug) {
      this.logger.warn(`Skipping PR: cannot parse owner/repo from ${redact(cfg.repoUrl)}`);
      return null;
    }
    const repo = this.config.workspaceRepoPath;

    // Only publish if the branch actually has commits ahead of the base.
    const ahead = await this.git(repo, [
      'rev-list',
      '--count',
      `origin/${cfg.repoBranch}..${input.branch}`,
    ]).catch(() => '0');
    if (ahead === '0') {
      this.logger.log(`Branch ${input.branch} has no commits ahead of ${cfg.repoBranch} — skipping`);
      return null;
    }

    try {
      this.logger.log(`Pushing ${input.branch} (${ahead} commits) to origin`);
      await this.git(repo, ['push', '--force-with-lease', 'origin', input.branch], cfg.githubToken);
    } catch (err) {
      this.logger.warn(`Push failed for ${input.branch}: ${(err as Error).message}`);
      return null;
    }

    return this.openPullRequest(slug, cfg.githubToken, {
      head: input.branch,
      base: cfg.repoBranch,
      title: input.title,
      body: input.body,
    });
  }

  /**
   * Shared-workspace push: send the current branch straight to origin/<repoBranch>
   * (no PR — the whole repo IS the working dir). Wires `origin` from the settings
   * repo URL and authenticates with the token via http.extraHeader (never exposed
   * to the agent). Returns a link to the pushed branch, or null if skipped/failed.
   */
  async pushSharedWorkspace(branch: string): Promise<string | null> {
    const cfg = await this.settings.workspaceConfig();
    const repoUrl = cfg.repoUrl;
    if (!repoUrl) return null; // no repo configured
    if (!cfg.githubToken) {
      this.logger.warn('Skipping push: no GitHub token configured');
      return null;
    }
    const repo = this.config.workspaceRepoPath;
    // Point origin at the configured repo (add if missing, else update).
    await this.git(repo, ['remote', 'set-url', 'origin', repoUrl]).catch(() =>
      this.git(repo, ['remote', 'add', 'origin', repoUrl]).catch(() => undefined),
    );
    // Nothing to push if there are no commits (shared mode never auto-commits).
    const head = await this.git(repo, ['rev-list', '--count', 'HEAD']).catch(() => '0');
    if (head === '0') return null;
    try {
      this.logger.log(`Pushing ${branch} → origin/${cfg.repoBranch}`);
      await this.git(repo, ['push', '-u', 'origin', `${branch}:${cfg.repoBranch}`], cfg.githubToken);
    } catch (err) {
      this.logger.warn(`Shared push failed: ${(err as Error).message}`);
      return null;
    }
    const slug = parseRepo(repoUrl);
    return slug
      ? `https://github.com/${slug.owner}/${slug.repo}/tree/${cfg.repoBranch}`
      : redact(repoUrl);
  }

  private async openPullRequest(
    slug: { owner: string; repo: string },
    token: string,
    pr: { head: string; base: string; title: string; body: string },
  ): Promise<string | null> {
    const api = `https://api.github.com/repos/${slug.owner}/${slug.repo}/pulls`;
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'local-dev-server',
      'content-type': 'application/json',
    };
    // Bound title/body so prompt content can't exceed GitHub's limits (→ 422)
    // or smuggle control characters into the request.
    const payload = {
      ...pr,
      title: clean(pr.title, 256) || `Agent changes (${pr.head})`,
      body: clean(pr.body, 60_000),
    };
    try {
      const res = await fetch(api, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (res.status === 201) {
        const created = (await res.json()) as { html_url: string };
        this.logger.log(`Opened PR ${created.html_url}`);
        return created.html_url;
      }
      if (res.status === 422) {
        // A PR for this head likely already exists — find and reuse it.
        const existing = await this.findOpenPr(slug, token, pr.head);
        if (existing) {
          this.logger.log(`PR already open: ${existing}`);
          return existing;
        }
      }
      this.logger.warn(`PR create failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    } catch (err) {
      this.logger.warn(`PR create error: ${(err as Error).message}`);
      return null;
    }
  }

  private async findOpenPr(
    slug: { owner: string; repo: string },
    token: string,
    head: string,
  ): Promise<string | null> {
    const url = `https://api.github.com/repos/${slug.owner}/${slug.repo}/pulls?state=open&head=${slug.owner}:${head}`;
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'local-dev-server',
      },
    });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ html_url: string }>;
    return list[0]?.html_url ?? null;
  }

  private async git(cwd: string, args: string[], token?: string): Promise<string> {
    const { stdout } = await exec('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: authEnv(token),
    });
    return stdout.trim();
  }
}

/** Inject the token via GIT_CONFIG_* env (not argv → not in /proc/cmdline). */
function authEnv(token?: string): NodeJS.ProcessEnv {
  if (!token) return process.env;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...process.env,
    // `http.extraHeader` is multi-valued: values from .git/config (persisted by
    // configureCredential so the agent can push) and from here would BOTH be
    // sent, producing two Authorization headers → GitHub 400 "Duplicate header".
    // An empty value first RESETS the accumulated list, then we add exactly ours.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.extraHeader',
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: Basic ${basic}`,
  };
}

/** Strip control characters (keeping tab/newline/CR) and cap length. */
function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = (text ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return stripped.length > max ? `${stripped.slice(0, max)}\n…[truncated]` : stripped;
}

/** Parse owner/repo from an https or ssh GitHub URL. */
function parseRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

function redact(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//');
}
