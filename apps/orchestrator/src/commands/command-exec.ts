import { spawnAsAgent, type AgentIsolation } from '@lds/agent-runner';

export interface ExecOptions {
  /** run with `sh -c` */
  command: string;
  cwd: string;
  /** exactly this environment — nothing of the orchestrator's own (the caller builds it like an agent's) */
  env: Record<string, string>;
  timeoutSec: number;
  signal?: AbortSignal;
  /** how much of the end of the output is kept (characters) */
  maxOutput?: number;
  /** run as the agent's own OS user (the same isolation the agent has) */
  isolation?: AgentIsolation | null;
  /** CPU niceness (1–19) so the machine keeps answering while a build runs */
  nice?: number;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  /** the end of what the command printed (stdout and stderr together) */
  output: string;
  /** the output was longer than what is kept */
  truncated: boolean;
  ms: number;
}

/**
 * Run one command and wait for it: a time limit and a cancel signal both stop the whole process group (the command's own children too), and only the end of
 * the output is kept — in a build log the failure is at the bottom. Never throws: a command that cannot start is a result with `exitCode: null`.
 */
export function execCommand(o: ExecOptions): Promise<ExecResult> {
  const maxOutput = o.maxOutput ?? 20_000;
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let total = 0;
    let timedOut = false;
    let cancelled = false;
    let done = false;
    let child: ReturnType<typeof spawnAsAgent> | undefined;
    const killGroup = () => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const finish = (code: number | null, signal: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, signal, timedOut, cancelled, output: out.length > maxOutput ? out.slice(out.length - maxOutput) : out, truncated: total > maxOutput, ms: Date.now() - started });
    };
    const keep = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      total += s.length;
      out += s;
      if (out.length > maxOutput * 2) out = out.slice(out.length - maxOutput); // do not hold a flood
    };
    const onAbort = () => {
      cancelled = true;
      killGroup();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, Math.max(1, o.timeoutSec) * 1000);
    if (o.signal?.aborted) {
      clearTimeout(timer);
      cancelled = true;
      return finish(null, null);
    }
    o.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = spawnAsAgent('sh', ['-c', o.command], { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], isolation: o.isolation ?? undefined, nice: o.nice });
    } catch (e) {
      out = `could not start: ${(e as Error).message}`;
      return finish(null, null);
    }
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e) => {
      out += `${out ? '\n' : ''}could not start: ${e.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
    // A grandchild that escaped the group (setsid) may keep the pipes open for ever: `close` would never come. The command itself has ended — give
    // the output a moment to drain, then let go of the pipes and finish.
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        finish(code, signal);
      }, 400).unref?.();
    });
  });
}
