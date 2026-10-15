/**
 * Git-over-https authentication for the workspace repo, shared by the
 * provisioning (clone/fetch) and publishing (push) services so they cannot
 * drift apart again (E-01/E-16).
 */

/**
 * Inject the token via `GIT_CONFIG_*` env (not argv → not in /proc/<pid>/cmdline,
 * not in the on-disk remote URL). The header is applied like `git -c http.extraHeader`.
 *
 * `http.extraHeader` is MULTI-valued: the value persisted in `.git/config`
 * (configureCredential — so the agent's own `git push` authenticates) and the
 * one from here would BOTH be sent, i.e. two Authorization headers → GitHub 400
 * "Duplicate header" → every fetch after the first clone fails and new worktrees
 * base on a stale `origin/<branch>`. An EMPTY value first resets the accumulated
 * list, then exactly ours is added.
 *
 * Without a token the environment is passed through untouched.
 */
export function gitAuthEnv(token?: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!token) return base;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...base,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.extraHeader',
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: Basic ${basic}`,
  };
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
