import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { LoginChild } from './login-session';

/** A plain child process (no terminal) as a `LoginChild`. */
export function spawnPlain(file: string, args: string[], env: NodeJS.ProcessEnv): LoginChild {
  const p = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  return wrap(p);
}

/** Single-quote a value for `sh -c`. */
export const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * A child on a pseudo-terminal, via `script(1)` (some CLIs — `claude setup-token` — refuse to run without a TTY). The terminal is
 * made wide so a long link or token is never wrapped across lines.
 */
export function spawnOnTty(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): LoginChild {
  const inner = `stty cols 500 rows 50 2>/dev/null; exec ${command}`;
  // util-linux: `script -qefc <cmd> /dev/null`; BSD/macOS: `script -q /dev/null sh -c <cmd>`.
  const args = platform === 'linux' ? ['-qefc', inner, '/dev/null'] : ['-q', '/dev/null', 'sh', '-c', inner];
  return wrap(spawn('script', args, { env, stdio: ['pipe', 'pipe', 'pipe'] }));
}

function wrap(p: ReturnType<typeof spawn>): LoginChild {
  return {
    onOutput: (cb) => {
      p.stdout?.on('data', (d: Buffer) => cb(d.toString('utf8')));
      p.stderr?.on('data', (d: Buffer) => cb(d.toString('utf8')));
    },
    onExit: (cb) => {
      p.on('exit', (code) => cb(code));
      p.on('error', () => cb(1));
    },
    write: (t) => {
      p.stdin?.write(t);
    },
    kill: () => {
      p.kill('SIGTERM');
    },
  };
}

/**
 * The Claude CLI the agents run on: `CLAUDE_BIN`, else the native binary that ships with the Agent SDK (found from the
 * agent-runner package), else `claude` from the PATH.
 */
export function claudeBin(): string {
  if (process.env.CLAUDE_BIN?.trim()) return process.env.CLAUDE_BIN.trim();
  try {
    const runnerRequire = createRequire(require.resolve('@lds/agent-runner'));
    const sdkRequire = createRequire(runnerRequire.resolve('@anthropic-ai/claude-agent-sdk'));
    for (const suffix of [`${process.platform}-${process.arch}`, `${process.platform}-${process.arch}-musl`]) {
      try {
        return sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/claude`);
      } catch {
        /* next variant */
      }
    }
  } catch {
    /* fall through */
  }
  return 'claude';
}

/** The environment a sign-in CLI runs with: ours, minus credentials that would make it skip or confuse the sign-in. */
export function loginEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, NO_COLOR: '1', BROWSER: 'none' };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  return env;
}
