/**
 * Git-over-https authentication with a token, shared by the provisioning
 * (clone/fetch) and publishing (push) services so they cannot drift apart
 * again (E-01/E-16). Round 1 of projects: `tokenAuth` / `anonymousAuth` are the
 * GitAuth shapes the GIT_CREDENTIALS provider (projects/git/git-access.service.ts)
 * hands out; the services only see a GitAuth, per command, and persist nothing.
 */
import type { GitAuth } from '../projects/git-credentials.port';

/**
 * The env entries that inject the token via `GIT_CONFIG_*` (not argv → not in /proc/<pid>/cmdline,
 * not in the on-disk remote URL). The header is applied like `git -c http.extraHeader`.
 *
 * `http.extraHeader` is MULTI-valued: a value an older version persisted in
 * `.git/config` and the one from here would BOTH be sent, i.e. two Authorization
 * headers → GitHub 400 "Duplicate header". An EMPTY value first resets the
 * accumulated list, then exactly ours is added. Nothing is persisted any more
 * (agents get no secrets): the auth travels per command only.
 */
export function tokenAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.extraHeader',
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: Basic ${basicCredential(token)}`,
  };
}

/** The base64 `x-access-token:<token>` GitHub expects in a Basic header. */
export function basicCredential(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

/** Without a token the environment is passed through untouched; with one, the GIT_CONFIG_* entries are added. */
export function gitAuthEnv(token?: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!token) return base;
  return { ...base, ...tokenAuthEnv(token) };
}

/** Every git process of a project runs without a terminal: a missing credential must fail at once, never hang on a prompt. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0' };

/** The GitAuth of a project that authenticates with a token over https. */
export function tokenAuth(token: string): GitAuth {
  const basic = basicCredential(token);
  return {
    env: { ...NO_PROMPT, ...tokenAuthEnv(token) },
    args: [],
    redact: (text) => text.split(token).join('***').split(basic).join('***'),
    anonymous: false,
  };
}

/** The GitAuth of a project without credentials (a public or local repository, or ssh through the ambient agent). */
export function anonymousAuth(): GitAuth {
  return { env: { ...NO_PROMPT }, args: [], redact: (text) => text, anonymous: true };
}

/** Does pushing to / fetching from this URL need a credential at all? (https does; ssh, git://, file:// do not — not from us, at least.) */
export function needsHttpCredentials(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** Strip any embedded credentials (`https://user:token@host/…`) before logging a repo URL. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//');
}

/** Parse owner/repo from an https or ssh GitHub URL (with or without `.git`). */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}
