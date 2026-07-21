import { type ChildProcess, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

/** A running ephemeral preview: the worktree's dev server + its allocated port. */
interface Preview {
  taskId: string;
  port: number;
  proc: ChildProcess;
  url: string;
  idleTimer: NodeJS.Timeout;
}

/** Reachable base for the preview servers (the orchestrator, on the compose net). */
const PUBLIC_HOST = process.env.PREVIEW_PUBLIC_HOST ?? 'orchestrator';
const PORT_BASE = parseInt(process.env.PREVIEW_PORT_BASE ?? '3200', 10);
const POOL_SIZE = parseInt(process.env.PREVIEW_POOL_SIZE ?? '4', 10);
const READY_TIMEOUT_MS = parseInt(process.env.PREVIEW_READY_TIMEOUT_MS ?? '120000', 10);
const IDLE_MS = parseInt(process.env.PREVIEW_IDLE_MS ?? '900000', 10); // 15 min

/**
 * Ephemeral per-task preview servers. On demand (an agent's `preview_worktree`
 * tool), runs the task's worktree as a dev server on an allocated port so the
 * browser MCP can screenshot the agent's in-progress changes — not the base
 * project. Torn down when the task settles or after an idle timeout, so no
 * standing per-task service is kept.
 *
 * The target app must honor `$PORT` and bind `0.0.0.0` (already a requirement of
 * the preview flow) so distinct tasks get distinct, reachable ports.
 */
@Injectable()
export class PreviewService implements OnModuleDestroy {
  private readonly logger = new Logger(PreviewService.name);
  private readonly running = new Map<string, Preview>();

  /**
   * Return a live preview URL for a task's worktree, starting the dev server if
   * one isn't already up for it. `cwd` is the directory to run (the worktree, or
   * its configured subdir).
   */
  async getOrStart(taskId: string, cwd: string): Promise<{ url: string }> {
    const existing = this.running.get(taskId);
    if (existing) {
      this.touch(existing);
      return { url: existing.url };
    }
    const port = this.allocatePort();
    if (port == null) {
      throw new Error(`No free preview slot (max ${POOL_SIZE} concurrent previews)`);
    }
    const url = `http://${PUBLIC_HOST}:${port}`;
    this.logger.log(`Starting preview for task ${taskId} at ${url} (cwd=${cwd})`);

    const proc = spawn(
      'sh',
      ['-lc', 'npm install --no-audit --no-fund && (npm run dev || npm start)'],
      {
        cwd,
        // Minimal env only — the preview runs the agent's own package scripts, so
        // never hand it the orchestrator's secrets (DB URL, LiteLLM/GitHub tokens,
        // hook secret, model keys). Just what a dev server needs to boot.
        env: scrubbedEnv(port),
        stdio: 'ignore',
        detached: false,
      },
    );

    const preview: Preview = {
      taskId,
      port,
      proc,
      url,
      idleTimer: setTimeout(() => this.stop(taskId), IDLE_MS),
    };
    this.running.set(taskId, preview);
    // If the process dies on its own, drop it from the registry.
    proc.on('exit', (code) => {
      if (this.running.get(taskId) === preview) {
        this.running.delete(taskId);
        clearTimeout(preview.idleTimer);
        this.logger.log(`Preview for task ${taskId} exited (code ${code})`);
      }
    });

    try {
      await this.waitReady(port, proc);
    } catch (err) {
      this.stop(taskId);
      throw new Error(`Preview failed to start: ${(err as Error).message}`);
    }
    return { url };
  }

  /** Stop and clean up a task's preview, if any. Idempotent. */
  stop(taskId: string): void {
    const p = this.running.get(taskId);
    if (!p) return;
    this.running.delete(taskId);
    clearTimeout(p.idleTimer);
    p.proc.removeAllListeners('exit');
    try {
      p.proc.kill('SIGTERM');
    } catch {
      // already gone
    }
    this.logger.log(`Stopped preview for task ${taskId} (port ${p.port})`);
  }

  onModuleDestroy(): void {
    for (const taskId of [...this.running.keys()]) this.stop(taskId);
  }

  /** Push the idle-teardown deadline out on activity. */
  private touch(p: Preview): void {
    clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(() => this.stop(p.taskId), IDLE_MS);
  }

  /** First free port in the pool, or null when all slots are taken. */
  private allocatePort(): number | null {
    const used = new Set([...this.running.values()].map((p) => p.port));
    for (let i = 0; i < POOL_SIZE; i++) {
      const port = PORT_BASE + i;
      if (!used.has(port)) return port;
    }
    return null;
  }

  /** Poll until the port accepts a TCP connection, the proc exits, or we time out. */
  private async waitReady(port: number, proc: ChildProcess): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode != null) throw new Error(`dev server exited early (code ${proc.exitCode})`);
      if (await tcpProbe(port)) return;
      await delay(1000);
    }
    throw new Error(`dev server not reachable on port ${port} within ${READY_TIMEOUT_MS}ms`);
  }
}

/** True when something is listening on 127.0.0.1:port. */
function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(2000, () => done(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A minimal, secret-free environment for the preview dev server. */
function scrubbedEnv(port: number): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TZ', 'TMPDIR'];
  const env: NodeJS.ProcessEnv = { PORT: String(port), HOST: '0.0.0.0', NODE_ENV: 'development' };
  for (const k of allow) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}
