/**
 * One way to run git for a project: the project's GitAuth goes in as ENV (+ its leading args), every call has a
 * timeout, and every error message is redacted before it leaves this file. The token never appears in argv
 * (http.extraHeader travels as GIT_CONFIG_* — see worktrees/git-auth.ts), the key only as a path in GIT_SSH_COMMAND.
 */
import { execFile } from 'node:child_process';
import type { GitAuth } from '../git-credentials.port';

export class GitRunError extends Error {
  constructor(
    message: string,
    /** redacted stderr */
    readonly stderr: string,
    readonly code: number | null,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'GitRunError';
  }
}

export interface GitRunOptions {
  cwd?: string;
  auth?: GitAuth;
  timeoutMs?: number;
  /** extra env on top of process.env + auth.env */
  env?: Record<string, string>;
  /** `-c safe.directory=*` so root's git accepts checkouts the agent user owns (agent isolation) */
  safeDirectory?: boolean;
  maxBuffer?: number;
}

export const ANONYMOUS_AUTH: GitAuth = { env: { GIT_TERMINAL_PROMPT: '0' }, args: [], redact: (t) => t, anonymous: true };

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

export function runGit(args: string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
  const auth = opts.auth ?? ANONYMOUS_AUTH;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...auth.env, ...(opts.env ?? {}) };
  const argv = [...(opts.safeDirectory ? ['-c', 'safe.directory=*'] : []), ...auth.args, ...args];
  const timeout = opts.timeoutMs ?? 60_000;
  return new Promise((resolvePromise, reject) => {
    execFile('git', argv, { cwd: opts.cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = auth.redact(String(stdout ?? ''));
      const errText = auth.redact(String(stderr ?? ''));
      if (!err) return resolvePromise({ stdout: out, stderr: errText });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string | null };
      const timedOut = Boolean(e.killed && e.signal === 'SIGKILL');
      const code = typeof e.code === 'number' ? e.code : null;
      const head = timedOut ? `git ${args[0] ?? ''} timed out after ${Math.round(timeout / 1000)} s` : e.code === 'ENOENT' ? 'git is not installed (or not on PATH)' : `git ${args[0] ?? ''} failed${code !== null ? ` (exit ${code})` : ''}`;
      const detail = errText.trim().split('\n').filter(Boolean).slice(-6).join('\n');
      reject(new GitRunError(detail ? `${head}: ${detail}` : head, errText, code, timedOut));
    });
  });
}
