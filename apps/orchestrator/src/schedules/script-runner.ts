import { spawn } from 'node:child_process';

export interface ScriptResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The tail of what the script printed (stdout and stderr together), at most `maxOutput` characters. */
  output: string;
  /** True when the output was longer than what is kept. */
  truncated: boolean;
  ms: number;
}

/** The environment a scheduled script gets: a few harmless variables — never the orchestrator's secrets (the same list the verification gate uses). */
const ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'CI', 'NODE_ENV', 'XDG_CACHE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

export const DEFAULT_SCRIPT_TIMEOUT_SEC = 600;
export const MAX_SCRIPT_TIMEOUT_SEC = 6 * 3600;

/**
 * Runs a script with `sh -c` in `cwd`: a minimal environment (plus `extraEnv`), a time limit (the whole process group is killed), and the last part of its
 * output kept. Never throws — a script that cannot start is a result with an exit code of null and the reason in `output`.
 */
export function runScript(script: string, opts: { cwd: string; timeoutSec?: number; extraEnv?: Record<string, string>; maxOutput?: number; env?: NodeJS.ProcessEnv }): Promise<ScriptResult> {
  const timeoutMs = Math.min(Math.max(opts.timeoutSec ?? DEFAULT_SCRIPT_TIMEOUT_SEC, 1), MAX_SCRIPT_TIMEOUT_SEC) * 1000;
  const maxOutput = opts.maxOutput ?? 8000;
  const source = opts.env ?? process.env;
  const env: Record<string, string> = Object.fromEntries(ENV_KEYS.flatMap((k) => (source[k] !== undefined ? [[k, source[k]!]] : [])));
  Object.assign(env, opts.extraEnv ?? {});
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let total = 0;
    let timedOut = false;
    let done = false;
    const finish = (r: Omit<ScriptResult, 'output' | 'truncated' | 'ms'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, output: out.length > maxOutput ? out.slice(out.length - maxOutput) : out, truncated: total > maxOutput, ms: Date.now() - started });
    };
    const keep = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      total += s.length;
      out += s;
      if (out.length > maxOutput * 2) out = out.slice(out.length - maxOutput); // the tail is what matters; do not hold a flood
    };
    let child;
    try {
      child = spawn('sh', ['-c', script], { cwd: opts.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = `could not start: ${(e as Error).message}`;
      return finish({ exitCode: null, signal: null, timedOut: false });
    }
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL'); // the group: the script's own children too
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (e) => {
      out += `${out ? '\n' : ''}could not start: ${e.message}`;
      finish({ exitCode: null, signal: null, timedOut });
    });
    child.on('close', (code, signal) => finish({ exitCode: code, signal, timedOut }));
  });
}
