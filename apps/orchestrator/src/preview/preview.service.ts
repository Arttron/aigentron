import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { playwrightSseUrl } from '../addons/addons-core';
import { parseLsofPids, parsePsTable, parseSsPids, portOwner } from './preview-core';

/** A running ephemeral preview: the worktree's dev server + its allocated port. */
interface Preview {
  taskId: string;
  port: number;
  proc: ChildProcess;
  url: string;
  idleTimer: NodeJS.Timeout;
}

/** Reachable base for the preview servers: the orchestrator on the compose network, unless PREVIEW_PUBLIC_HOST says otherwise (see PreviewService.publicHost). */
const COMPOSE_HOST = 'orchestrator';
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

  constructor(private readonly config: AppConfigService) {}

  /**
   * Where the browser reaches a preview. On the compose network the dev servers are `orchestrator:<port>`. On a server with the Playwright add-on
   * the browser runs on this very machine, where that name does not exist: `localhost`. PREVIEW_PUBLIC_HOST overrides both.
   */
  private publicHost(): string {
    const fromEnv = process.env.PREVIEW_PUBLIC_HOST?.trim();
    if (fromEnv) return fromEnv;
    try {
      return playwrightSseUrl(JSON.parse(readFileSync(join(this.config.addonsDir, 'playwright', 'state.json'), 'utf8'))) ? 'localhost' : COMPOSE_HOST;
    } catch {
      return COMPOSE_HOST;
    }
  }

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
    const port = await this.allocatePort();
    const url = `http://${this.publicHost()}:${port}`;
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
        // its own process group: npm and the dev server it starts are grandchildren of this shell, and stopping the preview must end all of them
        // (a server that outlived its preview kept the port and was later shown as another project's site)
        detached: true,
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
      await this.assertOurs(port, proc, cwd);
    } catch (err) {
      this.stop(taskId);
      throw new Error(`Preview failed to start: ${(err as Error).message}`);
    }
    return { url };
  }

  /** Stop and clean up a task's preview, if any. Idempotent. Says whether there was one. */
  stop(taskId: string): boolean {
    const p = this.running.get(taskId);
    if (!p) return false;
    this.running.delete(taskId);
    clearTimeout(p.idleTimer);
    p.proc.removeAllListeners('exit');
    killTree(p.proc);
    this.logger.log(`Stopped preview for task ${taskId} (port ${p.port})`);
    return true;
  }

  onModuleDestroy(): void {
    for (const taskId of [...this.running.keys()]) this.stop(taskId);
  }

  /** Push the idle-teardown deadline out on activity. */
  private touch(p: Preview): void {
    clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(() => this.stop(p.taskId), IDLE_MS);
  }

  /**
   * The first port of the pool that is free for real: not one of our previews and nothing at all answering on it (a server left behind by an agent or an earlier
   * preview would otherwise be taken for the new one and its pages shown as this project's).
   */
  private async allocatePort(): Promise<number> {
    const used = new Set([...this.running.values()].map((p) => p.port));
    const busy: string[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const port = PORT_BASE + i;
      if (used.has(port)) continue;
      if (!(await tcpProbe(port))) return port;
      const pids = await listenerPids(port);
      busy.push(`${port}${pids?.length ? ` (pid ${pids.join(', ')})` : ''}`);
      this.logger.warn(`Preview port ${port} is already in use by something that is not a preview of ours${pids?.length ? ` (pid ${pids.join(', ')})` : ''} — skipped`);
    }
    throw new Error(
      busy.length
        ? `No free preview port: ${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} answered by other processes that are not previews of ours (a dev server left running?). Stop them, or ask a person to.`
        : `No free preview slot (max ${POOL_SIZE} concurrent previews)`,
    );
  }

  /** The port answers — but is the answer from the dev server WE started (not one that was already there)? Throws when it is someone else's. */
  private async assertOurs(port: number, proc: ChildProcess, cwd: string): Promise<void> {
    if (!proc.pid) return;
    const listeners = await listenerPids(port);
    const owner = portOwner(listeners, proc.pid, await processTable());
    if (owner.kind === 'foreign') {
      throw new Error(`port ${port} is served by another process (pid ${owner.pids.join(', ')}), not by this project's dev server in ${cwd} — the page there would be a different site`);
    }
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

/** SIGTERM to the whole process group of a preview, SIGKILL a few seconds later for whatever ignored it. */
function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  const send = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, sig); // the group: the shell, npm and the dev server
      return true;
    } catch {
      try {
        proc.kill(sig);
        return true;
      } catch {
        return false; // already gone
      }
    }
  };
  if (!send('SIGTERM')) return;
  setTimeout(() => send('SIGKILL'), 5000).unref();
}

const run = (cmd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 4000, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout))));

/** Pids listening on a TCP port (lsof, else ss); null when neither tool is there to ask. */
async function listenerPids(port: number): Promise<number[] | null> {
  const lsof = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  if (lsof !== null) return parseLsofPids(lsof);
  const ss = await run('ss', ['-ltnpH', `sport = :${port}`]);
  return ss === null ? null : parseSsPids(ss);
}

async function processTable(): Promise<Map<number, number>> {
  return parsePsTable((await run('ps', ['-A', '-o', 'pid=,ppid='])) ?? '');
}
