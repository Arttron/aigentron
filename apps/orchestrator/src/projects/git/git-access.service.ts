/**
 * Repository access per project (docs/projects.md): the real GitCredentialsProvider behind GIT_CREDENTIALS.
 *
 *  - tokens and SSH keys are FILES in `<secrets>/projects/<slug>/` (ProjectSecretsStore) — the database holds only
 *    `repoAuth`; the orchestrator (root) reads them, agents never do;
 *  - `authFor(project)` turns them into the env git needs: the http.extraHeader scheme of worktrees/git-auth.ts for
 *    tokens (never in argv / a URL / a config file), `GIT_SSH_COMMAND` with the project's key + pinned known_hosts for ssh;
 *  - the connection test (`test`) explains what is wrong in words a person can act on;
 *  - the legacy AppSettings.githubToken of the default project is migrated to its file at boot (idempotent).
 */
import { hostname } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { SettingsService } from '../../settings/settings.service';
import { anonymousAuth, tokenAuth } from '../../worktrees/git-auth';
import { DEFAULT_PROJECT_SLUG, isRepoAuth, parseRepoUrl, type ParsedRepoUrl, type ProjectRepoAuth, type RepoProvider } from '../project-core';
import { ProjectsService, type ProjectRow } from '../projects.service';
import type { GitAuth, GitCredentialsProvider, ProjectGitRef } from '../git-credentials.port';
import { ProjectSecretsStore, type StoredLastTest } from './project-secrets';
import { generateEd25519, hostIsPinned, importPrivateKey, sshCommand, SshKeyError } from './ssh-keys';
import { GitRunError, runGit } from './git-runner';
import { classifyGitFailure, parseLsRemote, STEP_LABELS, summarizeReport, urlAuthProblem, type RepoTestReport, type RepoTestStep, type RepoTestStepId } from './repo-test-core';

/** A configuration problem the person can fix (→ 400 at the API). */
export class GitAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitAccessError';
  }
}

/** GET /api/projects/:slug/repo — never a secret. */
export interface RepoStatus {
  url: string | null;
  branch: string;
  subdir: string | null;
  provider: RepoProvider;
  auth: ProjectRepoAuth;
  tokenSet: boolean;
  /** `…abcd` (last 4 characters) or null */
  tokenHint: string | null;
  sshPublicKey: string | null;
  sshFingerprint: string | null;
  /** true/false for ssh URLs (is the host's key pinned for this project), null otherwise */
  hostKeyTrusted: boolean | null;
  lastTest: StoredLastTest | null;
}

export type CredentialsInput = { auth: 'none' } | { auth: 'token'; token?: string } | { auth: 'ssh'; action?: 'generate' | 'import'; privateKey?: string };

const LS_REMOTE_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 45_000;
const API_TIMEOUT_MS = 15_000;
const DNS_TIMEOUT_MS = 8_000;
const SSH_CONNECT_TIMEOUT_S = 15;

@Injectable()
export class GitAccessService implements GitCredentialsProvider, OnApplicationBootstrap {
  private readonly logger = new Logger(GitAccessService.name);
  readonly store: ProjectSecretsStore;

  constructor(
    private readonly config: AppConfigService,
    private readonly projects: ProjectsService,
    private readonly settings: SettingsService,
  ) {
    this.store = new ProjectSecretsStore(config.secretsDir);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.migrateLegacyToken().catch((e) => this.logger.error(`legacy GitHub token not migrated: ${(e as Error).message}`));
  }

  // ---- the seam -------------------------------------------------------------------------------------------

  /** How git authenticates for this project. Throws GitAccessError when the configuration cannot work. */
  async authFor(project: ProjectGitRef): Promise<GitAuth> {
    const auth: ProjectRepoAuth = isRepoAuth(project.repoAuth) ? project.repoAuth : 'none';
    const parsed = project.repoUrl ? parseRepoUrl(project.repoUrl) : null;
    if (auth === 'token') {
      if (parsed) {
        const problem = urlAuthProblem(parsed, 'token');
        if (problem) throw new GitAccessError(`project "${project.slug}": ${problem}`);
      }
      const token = await this.tokenOf(project.slug);
      if (!token) throw new GitAccessError(`project "${project.slug}" is set to token access but no token is stored — add one under Project → Repository → Access`);
      return tokenAuth(token); // the http.extraHeader scheme of worktrees/git-auth.ts: GIT_CONFIG_* env, nothing in argv
    }
    if (auth === 'ssh') {
      if (parsed) {
        const problem = urlAuthProblem(parsed, 'ssh');
        if (problem) throw new GitAccessError(`project "${project.slug}": ${problem}`);
      }
      const key = this.store.readSshKey(project.slug);
      if (!key) throw new GitAccessError(`project "${project.slug}" is set to SSH access but has no key yet — generate or import one under Project → Repository → Access`);
      return { env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: sshCommand(key.privateKeyPath, this.store.knownHostsPath(project.slug), { connectTimeoutSec: SSH_CONNECT_TIMEOUT_S }) }, args: [], redact: (t) => t, anonymous: false };
    }
    // none: public repository or a local path. An ssh URL still gets the project's pinned known_hosts + no prompts
    // (the server's own default identities apply — nothing of this project's).
    const anon = anonymousAuth();
    if (parsed?.protocol === 'ssh') anon.env.GIT_SSH_COMMAND = sshCommand(null, this.store.knownHostsPath(project.slug), { connectTimeoutSec: SSH_CONNECT_TIMEOUT_S });
    return anon;
  }

  /**
   * The token of a project that uses TOKEN access, for API-style use (the shared github MCP gets it as GITHUB_TOKEN for a run of this
   * project's task). null for public / ssh projects — the MCP server's own configured token (if any) then applies. Never logged.
   */
  async apiTokenFor(project: ProjectGitRef): Promise<string | null> {
    if (project.repoAuth !== 'token') return null;
    return this.tokenOf(project.slug);
  }

  /** The project's token: its file, or — for the default project only — the not-yet-migrated AppSettings value. */
  private async tokenOf(slug: string): Promise<string | null> {
    const fromFile = this.store.readToken(slug);
    if (fromFile || slug !== DEFAULT_PROJECT_SLUG) return fromFile;
    return (await this.settings.get()).githubToken ?? null;
  }

  // ---- status ---------------------------------------------------------------------------------------------

  async status(slug: string): Promise<RepoStatus> {
    const p = await this.projects.get(slug);
    return this.statusOf(p);
  }

  async statusOf(p: ProjectRow): Promise<RepoStatus> {
    const parsed = p.repoUrl ? parseRepoUrl(p.repoUrl) : null;
    const token = await this.tokenOf(p.slug);
    const key = this.store.readSshKey(p.slug);
    return {
      url: p.repoUrl,
      branch: p.repoBranch,
      subdir: p.repoSubdir,
      provider: parsed?.provider ?? 'generic',
      auth: isRepoAuth(p.repoAuth) ? p.repoAuth : 'none',
      tokenSet: Boolean(token),
      tokenHint: token ? `…${token.slice(-4)}` : null,
      sshPublicKey: key?.publicKey || null,
      sshFingerprint: key?.fingerprint ?? null,
      hostKeyTrusted: parsed?.protocol === 'ssh' ? hostIsPinned(this.store.readKnownHosts(p.slug), parsed.host) : null,
      lastTest: this.store.readLastTest(p.slug),
    };
  }

  // ---- changes --------------------------------------------------------------------------------------------

  /** URL / branch / subdir (validation lives in ProjectsService). A change forgets the last test. */
  async setRepo(slug: string, patch: { url?: string | null; branch?: string; subdir?: string | null }): Promise<RepoStatus> {
    const input: { repoUrl?: string | null; repoBranch?: string; repoSubdir?: string | null } = {};
    if (patch.url !== undefined) input.repoUrl = patch.url;
    if (patch.branch !== undefined) input.repoBranch = patch.branch;
    if (patch.subdir !== undefined) input.repoSubdir = patch.subdir;
    const row = await this.projects.update(slug, input);
    this.store.clearLastTest(row.slug);
    return this.statusOf(row);
  }

  /**
   * Set the access method. The secret arrives once and is written to its file; the response never carries it.
   *   none  → both the token and the key are removed
   *   token → the token file is written (an existing key is kept — switching back costs nothing)
   *   ssh   → generate: a fresh ed25519 key REPLACES any stored key (its deploy key must be registered anew);
   *           import: the given private key (unencrypted) is validated and stored
   */
  async setCredentials(slug: string, input: CredentialsInput): Promise<RepoStatus> {
    const p = await this.projects.get(slug);
    const parsed = p.repoUrl ? parseRepoUrl(p.repoUrl) : null;
    if (input.auth === 'none') {
      this.store.clearToken(p.slug);
      this.store.clearSshKey(p.slug);
      this.logger.log(`project "${p.slug}": repository access set to none (token and key removed)`);
    } else if (input.auth === 'token') {
      if (parsed) {
        const problem = urlAuthProblem(parsed, 'token');
        if (problem) throw new GitAccessError(problem);
      }
      const token = (input.token ?? '').trim();
      if (!token) throw new GitAccessError('give the token (it is stored once, in a file, and never shown again)');
      try {
        this.store.writeToken(p.slug, token);
      } catch (e) {
        throw new GitAccessError((e as Error).message);
      }
      if (this.store.readToken(p.slug) !== token) throw new GitAccessError('the token file could not be verified after writing — check the secrets dir');
      if (p.isDefault) await this.clearLegacyToken();
      this.logger.log(`project "${p.slug}": token stored (…${token.slice(-4)})`);
    } else if (input.auth === 'ssh') {
      if (parsed) {
        const problem = urlAuthProblem(parsed, 'ssh');
        if (problem) throw new GitAccessError(problem);
      }
      const action = input.action ?? (input.privateKey ? 'import' : 'generate');
      const comment = `aigentron:${p.slug}@${safeHost()}`;
      let key;
      try {
        key = action === 'import' ? importPrivateKey(input.privateKey ?? '', comment) : generateEd25519(comment);
      } catch (e) {
        if (e instanceof SshKeyError) throw new GitAccessError(e.message);
        throw e;
      }
      this.store.writeSshKey(p.slug, key);
      const back = this.store.readSshKey(p.slug);
      if (!back || back.fingerprint !== key.fingerprint) throw new GitAccessError('the key files could not be verified after writing — check the secrets dir');
      this.logger.log(`project "${p.slug}": SSH key ${action === 'import' ? 'imported' : 'generated'} (${key.type} ${key.fingerprint})`);
    } else {
      throw new GitAccessError('auth must be "none", "token" or "ssh"');
    }
    const row = p.repoAuth === input.auth ? p : await this.projects.update(p.slug, { repoAuth: input.auth });
    this.store.clearLastTest(p.slug);
    return this.statusOf(row);
  }

  /** Forget the pinned host key(s) of the project — the next connection pins the current one again (trust on first use). */
  async resetHostKey(slug: string): Promise<RepoStatus> {
    const p = await this.projects.get(slug);
    this.store.clearKnownHosts(p.slug);
    this.store.clearLastTest(p.slug);
    this.logger.log(`project "${p.slug}": pinned host key reset`);
    return this.statusOf(p);
  }

  // ---- the legacy token -----------------------------------------------------------------------------------

  /**
   * AppSettings.githubToken → `<secrets>/projects/default/token`, then the database value is cleared and the default
   * project's repoAuth becomes "token" when it was "none". Idempotent: nothing to do when the database has no token.
   * A token in the database is always the newer one (the old settings endpoint can still write it), so it wins.
   */
  async migrateLegacyToken(): Promise<'migrated' | 'nothing'> {
    const s = await this.settings.get();
    const token = s.githubToken?.trim();
    if (!token) return 'nothing';
    const def = await this.projects.getDefault();
    this.store.writeToken(def.slug, token);
    if (this.store.readToken(def.slug) !== token) throw new Error('the token file does not read back what was written');
    await this.clearLegacyToken();
    if (def.repoAuth === 'none') await this.projects.update(def.slug, { repoAuth: 'token' });
    this.logger.log(`GitHub token moved from the database to ${this.store.pathOf(def.slug, 'token')} (…${token.slice(-4)}); default project access: token`);
    return 'migrated';
  }

  private async clearLegacyToken(): Promise<void> {
    const s = await this.settings.get();
    if (s.githubToken) await this.settings.update({ githubToken: null });
  }

  // ---- the connection test --------------------------------------------------------------------------------

  /**
   * Read-only by default: `git ls-remote --symref` for reachability, authentication, the default branch and the
   * configured branch; the GitHub API for push permission when the token is a GitHub one. `checkWrite` adds a
   * `git push --dry-run` of a throwaway ref: it contacts the remote's receive side but changes nothing there.
   */
  async test(slug: string, opts: { checkWrite?: boolean } = {}): Promise<RepoTestReport> {
    const p = await this.projects.get(slug);
    const started = Date.now();
    const report = await this.runTest(p, opts);
    report.durationMs = Date.now() - started;
    const summary = summarizeReport(report);
    this.store.writeLastTest(p.slug, { at: new Date().toISOString(), ok: report.ok, summary, durationMs: report.durationMs });
    this.logger.log(`project "${p.slug}": repository test ${report.ok ? 'passed' : 'failed'} — ${summary}`);
    return report;
  }

  private async runTest(p: ProjectRow, opts: { checkWrite?: boolean }): Promise<RepoTestReport> {
    const auth: ProjectRepoAuth = isRepoAuth(p.repoAuth) ? p.repoAuth : 'none';
    const parsed = p.repoUrl ? parseRepoUrl(p.repoUrl) : null;
    const provider = parsed?.provider ?? 'generic';
    const steps = new Map<RepoTestStepId, RepoTestStep>();
    const set = (id: RepoTestStepId, ok: boolean | null, detail: string, hint?: string) => steps.set(id, { id, label: STEP_LABELS[id], ok, detail, ...(hint ? { hint } : {}) });
    const finish = (defaultBranch?: string | null): RepoTestReport => {
      const list = (['url', 'network', 'auth', 'branch', 'write', 'size'] as RepoTestStepId[]).map((id) => steps.get(id) ?? { id, label: STEP_LABELS[id], ok: null, detail: 'not checked' });
      return { ok: list.every((s) => s.ok !== false), provider, steps: list, ...(defaultBranch ? { defaultBranch } : {}), durationMs: 0 };
    };

    // 1. the URL and the access method go together
    if (!p.repoUrl) {
      set('url', false, 'no repository URL is set', 'Enter the repository URL first (https://host/owner/repo.git or git@host:owner/repo.git).');
      return finish();
    }
    const problem = urlAuthProblem(parsed, auth);
    if (!parsed || problem) {
      set('url', false, problem ?? 'the URL is not valid', 'Use https://host/owner/repo.git for token access or git@host:owner/repo.git for SSH access.');
      return finish();
    }
    set('url', true, `${parsed.protocol} → ${parsed.host || 'local path'}${parsed.owner ? ` / ${parsed.owner}/${parsed.repo}` : ''} (${provider}, access: ${auth})`);

    // credentials present?
    let gitAuth: GitAuth;
    try {
      gitAuth = await this.authFor(p);
    } catch (e) {
      set('auth', false, (e as Error).message, auth === 'ssh' ? 'Generate a key (or import one) under Access, add its public key to the repository, then test again.' : 'Save the token under Access, then test again.');
      return finish();
    }

    // 2. network: the host name resolves (a local path needs no network)
    if (parsed.protocol === 'file' || !parsed.host) set('network', null, 'a local path — no network involved');
    else {
      const dns = await withTimeout(lookup(parsed.host), DNS_TIMEOUT_MS).then(
        (a) => ({ ok: true as const, address: a.address }),
        (e) => ({ ok: false as const, message: (e as Error).message }),
      );
      if (!dns.ok) {
        const c = classifyGitFailure(dns.message, { provider, auth, protocol: parsed.protocol, phase: 'read', timedOut: /timed out/i.test(dns.message) });
        set('network', false, c.kind === 'unknown' ? `the host name ${parsed.host} cannot be resolved: ${dns.message}` : c.message, c.hint ?? 'Check the URL and the DNS / network of this server.');
        return finish();
      }
      set('network', true, `${parsed.host} resolves (${dns.address})`);
    }

    // 3. reachability + authentication + branches in one call
    const ls = await runGit(['ls-remote', '--symref', parsed.url, 'HEAD', 'refs/heads/*'], { auth: gitAuth, timeoutMs: LS_REMOTE_TIMEOUT_MS, cwd: tmpdir() }).then(
      (r) => ({ ok: true as const, stdout: r.stdout }),
      (e: GitRunError) => ({ ok: false as const, stderr: e.stderr || e.message, timedOut: e.timedOut, message: e.message }),
    );
    if (!ls.ok) {
      const c = classifyGitFailure(ls.stderr, { provider, auth, protocol: parsed.protocol, phase: 'read', timedOut: ls.timedOut });
      if (c.step === 'network') set('network', false, c.message, c.hint);
      set(c.step === 'network' ? 'auth' : c.step, c.step === 'network' ? null : false, c.step === 'network' ? 'not checked (no connection)' : c.message, c.step === 'network' ? undefined : c.hint);
      return finish();
    }
    const info = parseLsRemote(ls.stdout);
    set('auth', true, auth === 'none' ? 'the repository is readable without credentials' : auth === 'token' ? 'the token is accepted' : 'the SSH key is accepted (host key pinned)');

    // 4. the branch
    if (info.empty) set('branch', null, `the repository is empty — the first push creates "${p.repoBranch}"`);
    else if (info.heads[p.repoBranch]) set('branch', true, `"${p.repoBranch}" exists (${info.heads[p.repoBranch]!.slice(0, 10)})${info.defaultBranch ? `, default branch "${info.defaultBranch}"` : ''}`);
    else {
      const others = info.branches.slice(0, 8).join(', ');
      set('branch', false, `branch "${p.repoBranch}" does not exist on the remote${info.defaultBranch ? ` (default: "${info.defaultBranch}")` : ''}`, `Set the branch to ${info.defaultBranch ? `"${info.defaultBranch}"` : 'an existing one'}${others ? ` — the remote has: ${others}${info.branches.length > 8 ? ', …' : ''}` : ''}, or create "${p.repoBranch}" in the repository.`);
    }

    // 5. write access + 6. size
    let wrote = false;
    if (provider === 'github' && auth === 'token' && parsed.owner && parsed.repo) {
      const token = await this.tokenOf(p.slug);
      const api = await githubRepoProbe(parsed.owner, parsed.repo, token ?? '', API_TIMEOUT_MS);
      if (api.ok) {
        wrote = true;
        set('write', api.push, api.push ? 'the token may push (GitHub API: permissions.push)' : 'the token can read but not push (GitHub API: permissions.push = false)', api.push ? undefined : 'Give the token "Contents: read & write" on this repository (fine-grained) or the "repo" scope (classic), or accept read-only (agents can clone but not publish).');
        if (api.sizeKb !== undefined) set('size', true, `about ${(api.sizeKb / 1024).toFixed(api.sizeKb < 10_240 ? 1 : 0)} MB on GitHub${api.private !== undefined ? api.private ? ', private' : ', public' : ''}`);
      } else if (api.status === 401) set('write', false, 'the GitHub API rejects the token (401)', 'The token is invalid or expired — create a new one and save it here.');
      else if (api.status === 404) set('write', false, 'the GitHub API does not show the repository to this token (404)', 'A fine-grained token must list this repository under "Repository access"; a classic token needs the "repo" scope for private repositories.');
      else set('write', null, `the GitHub API could not be asked (${api.message})`);
    }
    if (!wrote && opts.checkWrite) {
      const push = await this.dryRunPush(parsed, gitAuth);
      if (push.ok) set('write', true, 'a dry-run push was accepted (nothing was changed on the remote)');
      else {
        const c = classifyGitFailure(push.stderr, { provider, auth, protocol: parsed.protocol, phase: 'write', timedOut: push.timedOut });
        set('write', false, c.kind === 'unknown' ? `the dry-run push was refused: ${push.stderr.trim().split('\n').slice(-1)[0] ?? ''}`.slice(0, 400) : c.message, c.hint);
      }
    } else if (!wrote) set('write', null, 'not checked — run the test with "check write access" (a dry-run push; nothing is changed on the remote)');
    if (!steps.has('size')) set('size', null, 'only known for GitHub repositories with token access');
    return finish(info.defaultBranch);
  }

  /** `git push --dry-run` of an empty commit to a throwaway ref from a scratch repository: the remote is contacted, nothing is written. */
  private async dryRunPush(parsed: ParsedRepoUrl, auth: GitAuth): Promise<{ ok: true } | { ok: false; stderr: string; timedOut: boolean }> {
    const dir = await mkdtemp(join(tmpdir(), 'aigentron-push-test-'));
    try {
      await runGit(['init', '-q', '-b', 'main'], { cwd: dir, timeoutMs: 10_000 });
      await runGit(['-c', 'user.email=test@aigentron.local', '-c', 'user.name=Aigentron access test', 'commit', '-q', '--allow-empty', '-m', 'access test (dry run)'], { cwd: dir, timeoutMs: 10_000 });
      const ref = `refs/heads/aigentron-access-test-${Date.now().toString(36)}`;
      await runGit(['push', '--dry-run', '--no-verify', parsed.url, `HEAD:${ref}`], { cwd: dir, auth, timeoutMs: PUSH_TIMEOUT_MS });
      return { ok: true };
    } catch (e) {
      const err = e as GitRunError;
      return { ok: false, stderr: err.stderr || err.message, timedOut: Boolean(err.timedOut) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function safeHost(): string {
  return (hostname() || 'server').replace(/[^A-Za-z0-9.-]+/g, '-').slice(0, 40);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then((v) => (clearTimeout(t), res(v)), (e) => (clearTimeout(t), rej(e)));
  });
}

type GithubProbe = { ok: true; push: boolean; sizeKb?: number; private?: boolean; defaultBranch?: string } | { ok: false; status: number; message: string };

/** GET /repos/{owner}/{repo} — the token goes in the Authorization header only; the response is never echoed. */
async function githubRepoProbe(owner: string, repo: string, token: string, timeoutMs: number): Promise<GithubProbe> {
  try {
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'aigentron' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` };
    const body = (await res.json()) as { permissions?: { push?: boolean }; size?: number; private?: boolean; default_branch?: string };
    return { ok: true, push: Boolean(body.permissions?.push), sizeKb: typeof body.size === 'number' ? body.size : undefined, private: body.private, defaultBranch: body.default_branch };
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message;
    return { ok: false, status: 0, message: msg.slice(0, 200) };
  }
}
