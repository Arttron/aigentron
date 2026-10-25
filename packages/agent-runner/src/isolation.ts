import { execFile, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AgentIsolation } from './types';

/**
 * Running an agent as a separate OS user (S-01). The orchestrator stays root;
 * the agent binary is started through a wrapper script that `setpriv`s to the
 * agent uid/gid before exec-ing the real binary. The wrapper reads three env
 * vars, set here on the agent's environment:
 *   LDS_AGENT_EXEC  — the real binary to exec (the Claude CLI, `codex`, …)
 *   LDS_AGENT_UID / LDS_AGENT_GID — who to become
 * Everything below is deliberately small and pure where it can be, so the
 * orchestrator's tests can cover the decisions without spawning anything.
 */
export const AGENT_EXEC_ENV = 'LDS_AGENT_EXEC';
export const AGENT_UID_ENV = 'LDS_AGENT_UID';
export const AGENT_GID_ENV = 'LDS_AGENT_GID';
/** Niceness the wrapper gives the agent (0 / unset = none). */
export const AGENT_NICE_ENV = 'LDS_AGENT_NICE';

/** A valid niceness for `nice -n`: 1-19, else 0 (= leave the priority alone; also always 0 on Windows). */
export function cleanNice(n: number | undefined): number {
  if (process.platform === 'win32' || typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(19, Math.trunc(n)));
}

const NICE_WRAPPER = `#!/bin/sh
# Starts the agent binary at a lower CPU priority, and as the first thing the kernel's out-of-memory killer takes (so a memory shortage costs one agent
# run, not the whole service). LDS_AGENT_EXEC = the real binary, LDS_AGENT_NICE = niceness. Without \`nice\` the agent simply starts as it is.
echo 500 > /proc/self/oom_score_adj 2>/dev/null || true
if [ -n "\${LDS_AGENT_NICE:-}" ] && command -v nice >/dev/null 2>&1; then exec nice -n "$LDS_AGENT_NICE" "$LDS_AGENT_EXEC" "$@"; fi
exec "$LDS_AGENT_EXEC" "$@"
`;

/** Whether the wrapper can really be started here (a temp dir mounted `noexec`, a missing /bin/sh … would make EVERY agent run fail to start). Probed once. */
let wrapperProbe: { path: string; ok: boolean } | null = null;
function wrapperWorks(path: string): boolean {
  if (wrapperProbe?.path === path) return wrapperProbe.ok;
  let ok = false;
  try {
    const r = spawnSync(path, ['-c', 'exit 0'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', [AGENT_EXEC_ENV]: '/bin/sh', [AGENT_NICE_ENV]: '1' }, timeout: 5000 });
    ok = r.status === 0 && !r.error;
  } catch {
    ok = false;
  }
  wrapperProbe = { path, ok };
  return ok;
}

/**
 * The nice wrapper for a run WITHOUT a separate agent user (with one, infra/agent-exec.sh does it): written once into the temp dir and tried out.
 * Null when it cannot be used here — the caller then runs the agent exactly as before, at normal priority, instead of failing every run.
 */
export function niceWrapperPath(): string | null {
  const path = join(tmpdir(), `aigentron-nice-exec-${process.getuid?.() ?? 0}.sh`);
  try {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== NICE_WRAPPER) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, NICE_WRAPPER, { mode: 0o755 });
      chmodSync(tmp, 0o755);
      renameSync(tmp, path);
    }
  } catch {
    return null;
  }
  return wrapperWorks(path) ? path : null;
}

/**
 * Env additions for an isolated agent process: HOME/TMPDIR/XDG dirs inside the
 * per-task home (the only place the agent user may write besides its work
 * dirs) and the wrapper's own vars. Applied AFTER buildAgentEnv's allowlist, so
 * the orchestrator's HOME (/root) never reaches the agent.
 */
export function isolationEnv(iso: AgentIsolation, realExec: string): Record<string, string> {
  const tmp = join(iso.home, 'tmp');
  return {
    HOME: iso.home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    USER: 'agent',
    LOGNAME: 'agent',
    XDG_CACHE_HOME: join(iso.home, '.cache'),
    XDG_CONFIG_HOME: join(iso.home, '.config'),
    XDG_DATA_HOME: join(iso.home, '.local', 'share'),
    [AGENT_EXEC_ENV]: realExec,
    [AGENT_UID_ENV]: String(iso.uid),
    [AGENT_GID_ENV]: String(iso.gid),
  };
}

/**
 * How to start `command args…` as the agent: unchanged without isolation, else
 * the wrapper with the real command handed over through the env. Pure.
 */
export function agentCommand(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  iso?: AgentIsolation,
  nice?: number,
): { command: string; args: string[]; env: Record<string, string> } {
  const n = cleanNice(nice);
  // `sh -c`: first make the process the kernel's preferred victim when memory runs out ($0 = niceness - 0 means "no nice" -, then the command and its
  // arguments), then nice (if asked) + exec. `nice` undefined = the caller knows nothing of this: the command is run as it is.
  if (!iso) {
    return nice === undefined || process.platform === 'win32'
      ? { command, args: [...args], env }
      : {
          command: 'sh',
          args: ['-c', 'echo 500 > /proc/self/oom_score_adj 2>/dev/null; if [ "$0" -gt 0 ] 2>/dev/null; then exec nice -n "$0" "$@"; fi; exec "$@"', String(n), command, ...args],
          env,
        };
  }
  return { command: iso.wrapper, args: [...args], env: { ...env, ...isolationEnv(iso, command), ...(n > 0 ? { [AGENT_NICE_ENV]: String(n) } : {}) } };
}

/**
 * The SDK's native Claude CLI binary (what `query()` would spawn by itself):
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude`, resolved
 * next to the installed SDK exactly like the SDK does. Needed because
 * `pathToClaudeCodeExecutable` is pointed at the wrapper, which must exec the
 * real thing.
 */
export function resolveClaudeExecutable(): string {
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkRequire = createRequire(sdkEntry);
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const candidates = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
  const errors: string[] = [];
  for (const pkg of candidates) {
    try {
      return sdkRequire.resolve(`${pkg}/claude${process.platform === 'win32' ? '.exe' : ''}`);
    } catch (err) {
      errors.push((err as Error).message.split('\n')[0] ?? String(err));
    }
  }
  throw new Error(`Claude CLI binary not found next to the SDK (${candidates.join(', ')}): ${errors.join('; ')}`);
}

/** Spawn `command` as the agent user when `isolation` is set, else exactly as before. */
export function spawnAsAgent(
  command: string,
  args: readonly string[],
  opts: SpawnOptions & { env: Record<string, string>; isolation?: AgentIsolation; nice?: number },
): ChildProcess {
  const { isolation, nice, ...rest } = opts;
  const c = agentCommand(command, args, opts.env, isolation, nice);
  return spawn(c.command, c.args, { ...rest, env: c.env });
}

/** Run a short command as the agent user and collect its exit code + output (for preflight checks). */
export function runAsAgent(
  iso: AgentIsolation,
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnAsAgent(command, args, { env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...env }, isolation: iso, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Fail closed: before a run, prove the wrapper exists and really switches to
 * the agent uid (a missing `setpriv`, a wrong uid, a non-executable wrapper all
 * surface here with a clear message instead of the agent silently running as
 * the orchestrator's user).
 */
export async function assertIsolationReady(iso: AgentIsolation): Promise<void> {
  const why = (detail: string) => new Error(`agent isolation (AGENT_RUN_AS_UID=${iso.uid}) is enabled but not working — refusing to run the agent as the orchestrator's user: ${detail}`);
  if (!Number.isInteger(iso.uid) || iso.uid <= 0 || !Number.isInteger(iso.gid) || iso.gid <= 0) throw why('uid/gid must be positive integers (never root)');
  try {
    await access(iso.wrapper, constants.X_OK);
  } catch {
    throw why(`wrapper ${iso.wrapper} is missing or not executable`);
  }
  const r = await runAsAgent(iso, 'id', ['-u']);
  if (r.code !== 0 || r.stdout.trim() !== String(iso.uid)) {
    throw why(r.stderr.trim() || (r.code === 0 ? `ran as uid ${r.stdout.trim() || '?'} instead of ${iso.uid}` : `wrapper exited with code ${r.code}`));
  }
}

/** `chown -R uid:gid path` — files the orchestrator created for the agent must belong to it before the run. */
export function chownTree(path: string, iso: AgentIsolation): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('chown', ['-R', `${iso.uid}:${iso.gid}`, path], (err) => (err ? reject(new Error(`chown ${path} for the agent user failed: ${err.message}`)) : resolve()));
  });
}
