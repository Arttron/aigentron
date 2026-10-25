import { isSafeBranchName } from '../projects/push-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { GIT_CREDENTIALS, type GitAuth, type GitCredentialsProvider } from '../projects/git-credentials.port';
import { runGit } from '../projects/git/git-runner';
import type { ProjectContext } from '../projects/project-context';
import { SettingsService } from '../settings/settings.service';
import { needsHttpCredentials, parseGithubRepo, redactUrl } from './git-auth';

export interface PublishInput {
  branch: string;
  /** PR title (task title). */
  title: string;
  /** PR body (e.g. the task prompt). */
  body: string;
}

/** The parts of a project the publisher needs. */
export type PublishTarget = Pick<ProjectContext, 'slug' | 'repoPath' | 'repoUrl' | 'repoBranch' | 'git'>;

/**
 * Publishes an agent's result branch back to the project's remote: pushes the branch and
 * opens (or finds) a pull request against the project's base branch (GitHub only).
 * Every git command carries the project's GitAuth for that command only (env / args — never the checkout's config).
 *
 * Best-effort: any failure (no credentials, no write access, network) is logged and
 * returns null — the task already succeeded locally, so we never fail it here.
 */
@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);

  constructor(
    @Inject(GIT_CREDENTIALS) private readonly credentials: GitCredentialsProvider,
    private readonly settings: SettingsService,
  ) {}

  /** The project's auth, or null (logged) when its configuration cannot work (a missing token / key). */
  private async authOf(project: PublishTarget, what: string): Promise<GitAuth | null> {
    try {
      return await this.credentials.authFor(project.git);
    } catch (err) {
      this.logger.warn(`[${project.slug}] Skipping ${what}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Push the branch and open/find a PR. Returns the PR URL, or null if skipped. */
  async publishResult(project: PublishTarget, input: PublishInput): Promise<string | null> {
    const repoUrl = project.repoUrl;
    if (!repoUrl) return null; // no-repo mode — nothing to push to
    const auth = await this.authOf(project, 'push/PR');
    if (!auth) return null;
    if (auth.anonymous && needsHttpCredentials(repoUrl)) {
      this.logger.warn(`[${project.slug}] Skipping push/PR: no GitHub token configured`);
      return null;
    }
    const slug = parseGithubRepo(repoUrl);
    if (!slug) {
      this.logger.warn(`[${project.slug}] Skipping PR: cannot parse owner/repo from ${redactUrl(repoUrl)}`);
      return null;
    }
    const repo = project.repoPath;

    // Only publish if the branch actually has commits ahead of the base.
    // (An empty remote has no origin/<base> yet: then every commit of the branch counts, and the branch is simply published.)
    const baseExists = await this.git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${project.repoBranch}`]).then(() => true, () => false);
    const ahead = await this.git(repo, ['rev-list', '--count', baseExists ? `origin/${project.repoBranch}..${input.branch}` : input.branch]).catch(() => '0');
    if (ahead === '0') {
      this.logger.log(`[${project.slug}] Branch ${input.branch} has no commits ahead of ${project.repoBranch} — skipping`);
      return null;
    }

    try {
      this.logger.log(`[${project.slug}] Pushing ${input.branch} (${ahead} commits) to origin`);
      await this.git(repo, ['push', '--force-with-lease', 'origin', input.branch], auth);
    } catch (err) {
      this.logger.warn(`[${project.slug}] Push failed for ${input.branch}: ${(err as Error).message}`);
      return null;
    }

    // The PR goes through the GitHub API with the project's token (the installation's one until it is migrated).
    const token = await this.apiToken(project);
    if (!token) {
      this.logger.warn(`[${project.slug}] Pushed ${input.branch}; no GitHub token for the PR API — open the pull request by hand`);
      return null;
    }
    return this.openPullRequest(slug, token, {
      head: input.branch,
      base: project.repoBranch,
      title: input.title,
      body: input.body,
    });
  }

  /**
   * `push_branch` (an agent asked, a person approved): push the LOCAL branch `branch` of the project's checkout to `origin` as `to`.
   * Never forced. Returns a sentence for the agent — success or the reason it did not work (credentials, rejected, no such branch).
   */
  async pushBranch(project: PublishTarget, branch: string, to: string): Promise<{ ok: boolean; message: string }> {
    const repoUrl = project.repoUrl;
    if (!repoUrl) return { ok: false, message: 'This project has no repository URL: there is nothing to push to (set it in the project settings).' };
    const auth = await this.authOf(project, 'push');
    if (!auth) return { ok: false, message: 'Push refused: the project has no usable credentials (open the project page and fix the repository access / test the repo).' };
    if (auth.anonymous && needsHttpCredentials(repoUrl)) return { ok: false, message: 'Push refused: this project has no GitHub token or SSH key configured (project page → Repository → access).' };
    const repo = project.repoPath;
    const exists = await this.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
    if (!exists) return { ok: false, message: `There is no local branch "${branch}" in the project's repository. Commit your work on it first (git branch / git commit), then ask again.` };
    // `origin` points at the project's URL (the sync does this; set it here too so a first push into a fresh checkout works).
    await this.git(repo, ['remote', 'set-url', 'origin', repoUrl]).catch(() => this.git(repo, ['remote', 'add', 'origin', repoUrl]).catch(() => undefined));
    try {
      await this.git(repo, ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${to}`], auth);
    } catch (err) {
      const full = auth.redact((err as Error).message);
      const why = full.split('\n').find((l) => /rejected|denied|permission|fatal/i.test(l)) ?? full.split('\n')[0] ?? '';
      this.logger.warn(`[${project.slug}] push_branch ${branch} → ${to} failed: ${why}`);
      // A rejected non-fast-forward: the remote branch has commits this checkout lacks.
      const behind = /rejected|non-fast-forward|fetch first|failed to push some refs/i.test(full) && !/permission|denied|authentication|could not read|host key/i.test(full);
      return { ok: false, message: `The push failed: ${why.slice(0, 300)}. Nothing was changed on the remote.${behind ? ' The remote branch has commits this repository does not have — a push is never forced; push to another branch name (`to`) or ask the person to reconcile it.' : ''}` };
    }
    const slug = parseGithubRepo(repoUrl);
    const link = slug ? `https://github.com/${slug.owner}/${slug.repo}/tree/${to}` : redactUrl(repoUrl);
    this.logger.log(`[${project.slug}] push_branch: ${branch} → origin/${to}`);
    return { ok: true, message: `Pushed "${branch}" to origin as "${to}" — ${link}` };
  }

  /**
   * `fetch_remote` (an agent asked): `git fetch --prune origin <branch>` in the project's checkout with the project's credentials, so `origin/<branch>` is current
   * in the checkout the agent's worktree shares. Moves only remote-tracking refs. Returns a sentence for the agent — success or the reason it did not work.
   */
  async fetchRemote(project: PublishTarget, branch?: string): Promise<{ ok: boolean; message: string }> {
    const repoUrl = project.repoUrl;
    if (!repoUrl) return { ok: false, message: 'This project has no repository URL: there is no remote to fetch from (set it in the project settings).' };
    const all = branch === 'all';
    const want = all ? null : (branch ?? project.repoBranch);
    if (want !== null && !isSafeBranchName(want)) return { ok: false, message: `Refused: "${want}" is not a plain branch name.` };
    const auth = await this.authOf(project, 'fetch');
    if (!auth) return { ok: false, message: 'Fetch refused: the project has no usable credentials (open the project page and fix the repository access / test the repo).' };
    if (auth.anonymous && needsHttpCredentials(repoUrl)) return { ok: false, message: 'Fetch refused: this project has no GitHub token or SSH key configured (project page → Repository → access).' };
    const repo = project.repoPath;
    await this.git(repo, ['remote', 'set-url', 'origin', repoUrl]).catch(() => this.git(repo, ['remote', 'add', 'origin', repoUrl]).catch(() => undefined));
    try {
      await this.git(repo, ['fetch', '--prune', 'origin', ...(want ? [want] : [])], auth);
    } catch (err) {
      const full = auth.redact((err as Error).message);
      const why = full.split('\n').find((l) => /denied|permission|fatal|host key|could not|couldn't/i.test(l)) ?? full.split('\n')[0] ?? '';
      this.logger.warn(`[${project.slug}] fetch_remote ${want ?? 'all'} failed: ${why}`);
      return { ok: false, message: `The fetch failed: ${why.slice(0, 300)}. Nothing was changed. If this is about access, a person must fix the project's repository access (project page → Repository → Test).` };
    }
    const head = want ? await this.git(repo, ['rev-parse', '--short', '--verify', '--quiet', `refs/remotes/origin/${want}`]).then((r) => r.trim(), () => '') : '';
    this.logger.log(`[${project.slug}] fetch_remote: ${want ?? 'all'}`);
    return { ok: true, message: want ? `Fetched origin/${want}${head ? ` — now at ${head}` : ''}. Your files and branches are unchanged: bring it in with \`git merge origin/${want}\` (or rebase).` : 'Fetched every branch of origin. Your files and branches are unchanged: bring what you need in with git merge / rebase.' };
  }

  /** The project's HTTPS token for the GitHub API (the port), else the installation's legacy one. */
  private async apiToken(project: PublishTarget): Promise<string | null> {
    const own = await this.credentials.apiTokenFor?.(project.git).catch(() => null);
    return own ?? (await this.settings.githubToken());
  }

  /**
   * Shared-mode push: send the current branch straight to origin/<repoBranch>
   * (no PR — the whole checkout IS the working dir). Wires `origin` from the project's
   * repo URL and authenticates through the credentials port (never exposed to the
   * agent). Returns a link to the pushed branch, or null if skipped/failed.
   */
  async pushSharedWorkspace(project: PublishTarget, branch: string): Promise<string | null> {
    const repoUrl = project.repoUrl;
    if (!repoUrl) return null; // no repo configured
    const auth = await this.authOf(project, 'push');
    if (!auth) return null;
    if (auth.anonymous && needsHttpCredentials(repoUrl)) {
      this.logger.warn(`[${project.slug}] Skipping push: no GitHub token configured`);
      return null;
    }
    const repo = project.repoPath;
    // Point origin at the project's repo (add if missing, else update).
    await this.git(repo, ['remote', 'set-url', 'origin', repoUrl]).catch(() =>
      this.git(repo, ['remote', 'add', 'origin', repoUrl]).catch(() => undefined),
    );
    // Nothing to push if there are no commits (shared mode never auto-commits).
    const head = await this.git(repo, ['rev-list', '--count', 'HEAD']).catch(() => '0');
    if (head === '0') return null;
    try {
      this.logger.log(`[${project.slug}] Pushing ${branch} → origin/${project.repoBranch}`);
      await this.git(repo, ['push', '-u', 'origin', `${branch}:${project.repoBranch}`], auth);
    } catch (err) {
      this.logger.warn(`[${project.slug}] Shared push failed: ${(err as Error).message}`);
      return null;
    }
    const slug = parseGithubRepo(repoUrl);
    return slug ? `https://github.com/${slug.owner}/${slug.repo}/tree/${project.repoBranch}` : redactUrl(repoUrl);
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

  private async git(cwd: string, args: string[], auth?: GitAuth): Promise<string> {
    // safeDirectory: with agents on their own OS user (S-01) the checkout belongs to that user, which root's git would refuse.
    const { stdout } = await runGit(args, { cwd, auth, safeDirectory: true, timeoutMs: 10 * 60_000 });
    return stdout.trim();
  }
}

/** Strip control characters (keeping tab/newline/CR) and cap length. */
function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = (text ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return stripped.length > max ? `${stripped.slice(0, max)}\n…[truncated]` : stripped;
}
