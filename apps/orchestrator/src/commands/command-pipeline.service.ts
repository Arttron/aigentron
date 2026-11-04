import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { applyNodeHeapLimit, buildCommandEnv, type AgentIsolation } from '@lds/agent-runner';
import { commandWeight, compressText } from '@lds/shared';
import { ApprovalsService } from '../approvals/approvals.service';
import { AppConfigService } from '../config/app-config.service';
import { SettingsService } from '../settings/settings.service';
import { waitForCapacity } from '../queue/capacity-gate';
import { clearHold, setHold } from '../queue/holds';
import { CommandQueue, QueueAbortedError } from './command-queue';
import { execCommand, type ExecResult } from './command-exec';

/** What one agent run lends the pipeline: where its commands run and under whose rules. Registered by the executor, valid while the run lasts. */
export interface CommandRun {
  cwd: string;
  /** the write boundary, for the same dangerous-command check a Bash call gets */
  workspaceRoot: string;
  extraWriteRoots?: string[];
  protectedPaths?: string[];
  modelTier?: string;
  knownVars?: Record<string, string>;
  isolation?: AgentIsolation | null;
  /** the run's session, so the approval card of a pipeline command shows where it came from */
  agentSessionId?: string;
  /** heap cap (MB) for Node processes, as the agent has */
  nodeMaxMb?: number;
}

interface Ctx extends CommandRun {
  taskId: string;
  token: string;
  exp: number;
}

export const COMMAND_TIMEOUT_DEFAULT_SEC = 900;
export const COMMAND_TIMEOUT_MAX_SEC = 3600;
/** A token lives this long after its last use; the run's own end removes it earlier. */
const RUN_TTL_MS = 12 * 60 * 60_000;

/** The text an agent reads back: how it ended, how long it waited and ran, and the end of the output. Pure. */
export function formatCommandResult(r: ExecResult, waitedMs: number, outputAfterFilter: string): string {
  const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const how = r.cancelled ? 'cancelled' : r.timedOut ? `stopped: it ran longer than its time limit (${secs(r.ms)})` : r.exitCode === 0 ? 'finished, exit code 0' : r.exitCode === null ? `could not run${r.signal ? ` (${r.signal})` : ''}` : `failed, exit code ${r.exitCode}`;
  const head = `${how} — ran ${secs(r.ms)}${waitedMs >= 1000 ? `, waited ${secs(waitedMs)} in the queue` : ''}`;
  const body = outputAfterFilter.trim();
  return `${head}${body ? `\n${r.truncated ? '(the end of the output)\n' : ''}${body}` : '\n(no output)'}`;
}

/**
 * The command pipeline (`commands` MCP server, tool `run_command`): the heavy commands of every task — builds, tests, installs — wait in ONE queue, only a
 * few run at once, and each starts only when the machine is not busy. The server runs the command in the task's own folder, as the agent's user, and
 * hands back the end of the output (filtered like the rest of the agent's text). The dangerous-command check is the same as for Bash — it just happens here.
 * Each run gets its own bearer token (it names the task), like the browser server.
 */
@Injectable()
export class CommandPipelineService {
  private readonly logger = new Logger(CommandPipelineService.name);
  private readonly runs = new Map<string, Ctx>();
  readonly queue: CommandQueue;
  private approvalsCache?: ApprovalsService;

  constructor(
    private readonly config: AppConfigService,
    private readonly settings: SettingsService,
    private readonly moduleRef: ModuleRef,
  ) {
    let slots = 1;
    const refresh = () => void this.settings.heavySlots().then((n) => ((slots = n), this.queue.slotsChanged())).catch(() => undefined);
    refresh();
    setInterval(refresh, 10_000).unref?.();
    this.queue = new CommandQueue(
      () => slots,
      (onWait, signal) =>
        waitForCapacity({
          limits: { maxLoadPerCpu: this.config.agentMaxLoadPerCpu, minFreeMemMb: this.config.agentMinFreeMemMb, maxStealPct: this.config.agentMaxStealPct },
          onWait,
          signal,
        }).then(() => undefined),
    );
  }

  private get approvals(): ApprovalsService {
    return (this.approvalsCache ??= this.moduleRef.get(ApprovalsService, { strict: false }));
  }

  /** A bearer for one agent run; it expires on its own. */
  register(taskId: string, run: CommandRun, ttlMs = RUN_TTL_MS): { token: string } {
    const token = randomBytes(24).toString('hex');
    this.runs.set(token, { ...run, taskId, token, exp: Date.now() + ttlMs });
    return { token };
  }

  /**
   * One attempt is over: ITS token goes and ITS commands stop. An overlapping attempt of the same task (a stale run being replaced) keeps its own token
   * and its own commands — this is why it is the token, not the task id, that identifies what to remove.
   */
  unregister(token: string): void {
    const c = this.runs.get(token);
    this.runs.delete(token);
    const n = this.queue.cancelOwner(token);
    if (c) {
      if (n) this.logger.log(`Task ${c.taskId}: ${n} command(s) stopped with its run`);
      if (![...this.runs.values()].some((x) => x.taskId === c.taskId)) clearHold(c.taskId);
    }
  }

  /**
   * The task was cancelled, closed or deleted: every command it has in the queue or running is stopped now (not when its run finally unwinds), and its
   * tokens go, so nothing of it can start again.
   */
  cancelTask(taskId: string): number {
    for (const [t, c] of this.runs) if (c.taskId === taskId) this.runs.delete(t);
    const n = this.queue.cancelTask(taskId);
    clearHold(taskId);
    if (n) this.logger.log(`Task ${taskId}: ${n} command(s) stopped (the task was cancelled or removed)`);
    return n;
  }

  private ctxOf(authHeader: string | undefined): Ctx | null {
    const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!provided) return null;
    const a = Buffer.from(provided);
    const now = Date.now();
    let found: Ctx | null = null;
    for (const [t, ctx] of this.runs) {
      if (ctx.exp <= now) {
        this.runs.delete(t);
        continue;
      }
      const b = Buffer.from(t);
      if (a.length === b.length && timingSafeEqual(a, b)) found = ctx;
    }
    if (found) found.exp = now + RUN_TTL_MS; // in use: a long run keeps its token
    return found;
  }

  /** The same dangerous-command check a Bash call gets (a card for the person when needed). Throws with the reason when the command may not run. */
  private async authorize(ctx: Ctx, command: string): Promise<void> {
    const check = await this.approvals.check({
      taskId: ctx.taskId,
      agentSessionId: ctx.agentSessionId,
      toolName: 'Bash',
      toolInput: { command },
      workspaceRoot: ctx.workspaceRoot,
      extraWriteRoots: ctx.extraWriteRoots,
      protectedPaths: ctx.protectedPaths,
      modelTier: ctx.modelTier,
      knownVars: ctx.knownVars,
    });
    if (check.allow) return;
    if (!check.approvalId) throw new Error(`Not allowed: ${check.reason ?? 'denied'}`);
    const v = await this.approvals.waitForVerdict(check.approvalId);
    if (v.status !== 'approved') throw new Error('The person did not allow this command. Do not try again; tell them what you wanted to run and ask.');
  }

  /** Run one command for a task (heavy ones wait their turn). Throws only for "not allowed" / "cancelled"; a failing command is a normal result. */
  async run(ctx: Ctx, command: string, timeoutSec: number, signal?: AbortSignal): Promise<string> {
    const weight = commandWeight(command);
    if (weight === 'long-running') {
      throw new Error('This command keeps running (a dev server, a watcher), so it cannot be waited for here. Start it with Bash in the background (`cmd > /tmp/x.log 2>&1 &`) and read its log.');
    }
    await this.authorize(ctx, command);
    const env = buildCommandEnv(process.env, ctx.knownVars?.LDS_ATTACHMENTS_DIR);
    env.CI = '1'; // no prompts, no watch mode
    applyNodeHeapLimit(env, ctx.nodeMaxMb);
    if (ctx.knownVars?.TMPDIR) env.TMPDIR = ctx.knownVars.TMPDIR;
    const exec = (s: AbortSignal) => execCommand({ command, cwd: ctx.cwd, env, timeoutSec, signal: s, isolation: ctx.isolation, nice: this.config.agentNice });
    const queuedAt = Date.now();
    let startedAt = queuedAt;
    const label = command.replace(/\s+/g, ' ').slice(0, 80);
    let r: ExecResult;
    try {
      if (weight === 'light') {
        r = await exec(signal ?? new AbortController().signal);
      } else {
        r = await this.queue.run(
          { taskId: ctx.taskId, label, owner: ctx.token },
          (s) => {
            startedAt = Date.now();
            clearHold(ctx.taskId);
            return exec(s);
          },
          {
            signal,
            onWait: ({ ahead, reason }) => setHold(ctx.taskId, reason ?? (ahead > 0 ? `a heavy command waits for its turn (${ahead} ahead): ${label}` : `a heavy command is about to start: ${label}`), 'command'),
          },
        );
      }
    } catch (e) {
      if (e instanceof QueueAbortedError) throw new Error('The command was cancelled before it started.');
      throw e;
    } finally {
      clearHold(ctx.taskId);
    }
    const cfg = await this.settings.compression().catch(() => undefined);
    const filtered = cfg ? compressText(r.output, cfg, 'tool').text : r.output;
    this.logger.log(`Task ${ctx.taskId} ran [${weight}] ${label} → ${r.exitCode ?? r.signal ?? 'no exit'} in ${r.ms} ms (queued ${startedAt - queuedAt} ms)`);
    return formatCommandResult(r, startedAt - queuedAt, filtered);
  }

  private build(ctx: Ctx): McpServer {
    const server = new McpServer({ name: 'commands', version: '1.0.0' });
    server.registerTool(
      'run_command',
      {
        description:
          'Run a HEAVY shell command — a build, a test run, an install, a type check (npm/pnpm/yarn install|build|test, tsc, vitest, jest, pytest, cargo, go, make, docker build…) — in the task\'s folder. These commands go through a shared queue: only a few run at once on this server and each waits while the machine is busy, so the result may take a while to come. Returns how it ended and the END of the output (where a failure is). Use Bash for everything light (git, ls, cat, small scripts) and for anything that keeps running (a dev server, --watch).',
        inputSchema: { command: z.string().min(1).max(8000), timeoutSec: z.number().int().min(10).max(COMMAND_TIMEOUT_MAX_SEC).optional() },
      },
      async (a: { command: string; timeoutSec?: number }, extra) => {
        try {
          const text = await this.run(ctx, a.command, a.timeoutSec ?? COMMAND_TIMEOUT_DEFAULT_SEC, extra?.signal);
          return { content: [{ type: 'text' as const, text }] };
        } catch (e) {
          return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] };
        }
      },
    );
    return server;
  }

  async handle(req: Request, res: Response): Promise<void> {
    const ctx = this.ctxOf(req.headers.authorization);
    if (!ctx) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).set('Allow', 'POST').send('Method Not Allowed');
      return;
    }
    const server = this.build(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
