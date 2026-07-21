import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  isInitializeRequest,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { isTerminalStatus, type TaskStatus } from '@lds/shared';
import { TasksService } from '../tasks/tasks.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AgentRegistryService } from '../agent-registry/agent-registry.service';
import { AgentEventBus } from '../bus/agent-event-bus';
import { AppConfigService } from '../config/app-config.service';

/** One connected MCP client: its transport, server, and live push wiring. */
interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Resource URIs this client is following (auto-added on create/get, or via
   *  an explicit resources/subscribe request). Drives push notifications. */
  followed: Set<string>;
  unsubscribeBus: () => void;
}

const RESOURCE_PREFIX = 'task://';
const taskUri = (id: string) => `${RESOURCE_PREFIX}${id}`;

/** A compact, human-readable detail for an approval, pulled from its toolInput
 *  (the command for Bash, the path for a file op, else the raw input). Capped. */
function approvalDetails(toolInput: unknown): string {
  const cap = (s: string) => (s.length > 400 ? `${s.slice(0, 400)}…` : s);
  if (toolInput && typeof toolInput === 'object') {
    const o = toolInput as Record<string, unknown>;
    if (typeof o.command === 'string') return cap(o.command);
    const path = o.file_path ?? o.path ?? o.filePath;
    if (typeof path === 'string') return cap(path);
  }
  try {
    return cap(JSON.stringify(toolInput));
  } catch {
    return '';
  }
}

/** Doc exposure limits — keep listing cheap and reads bounded. */
const DOC_MAX_FILES = 500;
const DOC_MAX_SCAN = 20000;
const DOC_MAX_BYTES = 256 * 1024;
const DOC_SKIP_DIRS = new Set([
  'node_modules', '.git', '.worktrees', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache',
]);

/** Runtime usage guide returned by the `help` tool (and the guide:// resource). */
const USAGE_GUIDE = `# LDS Fleet — MCP usage guide

You are connected to a local agent fleet. You describe work; the fleet's agents
(a PM lead that decomposes and delegates to specialists) implement it in the
project's git repo. Everything runs asynchronously.

## The loop

1. **Context** — the fleet knows nothing about your project except what you pass.
   Call \`list_docs\` then \`read_doc\` to read the project's markdown docs, and put
   the relevant details into your task prompt.
2. **Create** — \`create_task({ prompt, title?, agentName? })\`. Give a full,
   self-contained prompt. Returns an id.
3. **Wait** — \`wait_for_task({ id })\` blocks until the task settles, then returns
   its status plus signals:
   - \`awaitingInput: true\` — an agent asked a question (see \`summary\`). Answer with
     \`follow_up({ id, message })\`, then wait again.
   - \`awaitingApproval: true\` — a gate needs a decision (see \`pendingApprovals\`).
     Call \`approve_task({ id })\` or \`deny_task({ id })\`, then wait again.
   - \`done\` / \`failed\` / \`stalled\` / \`cancelled\` — finished; read \`summary\` and
     \`prUrl\`.
4. **Iterate** — \`follow_up\` also adds more work to a settled task.

## Tools

- \`ping\` — instant liveness check (no queue/DB).
- \`help\` — this guide.
- \`list_docs\` / \`read_doc(path)\` — read the project's docs for context.
- \`list_agents\` / \`get_agent(name)\` — see the fleet's agents and their skills, to
  pick an \`agentName\` (or omit it for the default PM lead).
- \`create_task(prompt, title?, agentName?, references?)\` — queue work.
- \`wait_for_task(id, timeoutSec?)\` — block until the task settles; the reliable
  way to learn the result.
- \`get_task(id)\` — snapshot a task (status, summary, prUrl, subtasks, signals).
- \`list_tasks(q?, page?, pageSize?)\` — browse/search tasks.
- \`follow_up(id, message)\` — answer a question or add context (task must be settled).
- \`approve_task(id)\` / \`deny_task(id)\` — resolve a needs_approval gate.
- \`cancel_task(id)\` — stop a task.

## Notes

- Prefer \`wait_for_task\` over polling \`get_task\`.
- \`follow_up\` / \`approve_task\` work once the task has settled/blocked — not mid-run.
- Task summaries and PR links come from the agents; a task with no changes won't
  have a PR.`;

/**
 * Hosts a Streamable-HTTP MCP server so external clients (Claude Desktop,
 * Claude Code, a browser MCP client) can drive the fleet: create tasks, read
 * their status/result, follow up, cancel. Everything is a thin adapter over
 * TasksService — no new state.
 *
 * Async results are delivered as `notifications/resources/updated` for the
 * task's `task://<id>` resource over the session's SSE stream: a client that
 * created or fetched a task (or explicitly subscribed) is pushed an update on
 * every status change, then re-reads the resource to see the new summary/PR.
 */
@Injectable()
export class McpHostService implements OnModuleDestroy {
  private readonly logger = new Logger(McpHostService.name);
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly tasks: TasksService,
    private readonly approvals: ApprovalsService,
    private readonly agents: AgentRegistryService,
    private readonly bus: AgentEventBus,
    private readonly config: AppConfigService,
  ) {}

  onModuleDestroy(): void {
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
  }

  /** Number of live MCP client sessions (for the dashboard status view). */
  activeSessions(): number {
    return this.sessions.size;
  }

  /** POST /api/mcp — JSON-RPC requests (incl. the initialize handshake). */
  async handlePost(req: Request, res: Response): Promise<void> {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const existing = sid ? this.sessions.get(sid) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }
    if (sid || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session; send an initialize request first.' },
        id: null,
      });
      return;
    }
    await this.openSession(req, res);
  }

  /** GET /api/mcp — opens the SSE stream that carries server→client pushes. */
  async handleGet(req: Request, res: Response): Promise<void> {
    await this.withSession(req, res, (s) => s.transport.handleRequest(req, res));
  }

  /** DELETE /api/mcp — client-initiated session teardown. */
  async handleDelete(req: Request, res: Response): Promise<void> {
    await this.withSession(req, res, (s) => s.transport.handleRequest(req, res));
  }

  private async withSession(
    req: Request,
    res: Response,
    fn: (s: Session) => Promise<void>,
  ): Promise<void> {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const session = sid ? this.sessions.get(sid) : undefined;
    if (!session) {
      res.status(400).send('Unknown or missing mcp-session-id');
      return;
    }
    await fn(session);
  }

  /** Spin up a fresh transport + server for an initialize request. */
  private async openSession(req: Request, res: Response): Promise<void> {
    const followed = new Set<string>();
    const origins = this.config.mcpAllowedOrigins;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // v1 has no bearer token; when origins are configured we at least block
      // DNS-rebinding (the MCP-spec-recommended guard for local servers).
      ...(origins.length
        ? { enableDnsRebindingProtection: true, allowedOrigins: origins }
        : {}),
      onsessioninitialized: (id) => {
        const unsubscribeBus = this.bus.subscribe((event) => {
          if (event.type !== 'task-status') return;
          const uri = taskUri(event.payload.taskId);
          if (!followed.has(uri)) return;
          void server.server
            .notification({ method: 'notifications/resources/updated', params: { uri } })
            .catch(() => undefined);
        });
        this.sessions.set(id, { transport, server, followed, unsubscribeBus });
        this.logger.log(`MCP session opened: ${id} (${this.sessions.size} active)`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.closeSession(transport.sessionId);
    };

    const server = this.buildServer(followed);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  private closeSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.unsubscribeBus();
    void s.server.close().catch(() => undefined);
    this.logger.log(`MCP session closed: ${id} (${this.sessions.size} active)`);
  }

  /** Build the per-session MCP server: fleet tools + the task resource. */
  private buildServer(followed: Set<string>): McpServer {
    const server = new McpServer(
      { name: 'lds-fleet', version: '0.1.0' },
      {
        capabilities: { resources: { subscribe: true } },
        instructions:
          'Drive a local agent fleet: create_task queues work; it runs ' +
          'asynchronously. To get the result, call wait_for_task(id) — it blocks ' +
          'until the task settles and returns its status + summary (resource-aware ' +
          'clients can instead watch task://<id> for resources/updated pushes). ' +
          'When it returns, check the signals: awaitingInput=true means the agent ' +
          'asked a question (answer it with follow_up(id, message)); ' +
          'awaitingApproval=true means a gate needs a decision (approve_task(id) or ' +
          'deny_task(id)). Otherwise it is done/failed. ' +
          'The project the fleet works on is exposed as doc://<path> resources ' +
          '(its markdown docs); tool-only clients can use list_docs + read_doc ' +
          'to read them for context before creating tasks.',
      },
    );

    server.registerTool(
      'ping',
      {
        title: 'Health check',
        description:
          'Instant liveness check — returns immediately without touching the task queue or DB. ' +
          'Use it to tell "MCP server is up" from "a task tool is slow/stuck".',
        inputSchema: {},
      },
      async () => this.json({ ok: true, time: new Date().toISOString(), mcpSessions: this.sessions.size }),
    );

    server.registerTool(
      'help',
      {
        title: 'How to use this MCP server',
        description:
          'Return a usage guide for this fleet MCP: the create → wait → follow_up/approve ' +
          'loop and every tool. Call this first if unsure how to drive the fleet.',
        inputSchema: {},
      },
      async () => ({ content: [{ type: 'text' as const, text: USAGE_GUIDE }] }),
    );

    server.registerResource(
      'guide',
      'guide://usage',
      { title: 'MCP usage guide', description: 'How to drive the fleet over MCP.', mimeType: 'text/markdown' },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: USAGE_GUIDE }],
      }),
    );

    server.registerTool(
      'create_task',
      {
        title: 'Create a task',
        description:
          'Queue a new task for the fleet. Returns its id. Runs asynchronously — ' +
          'then call wait_for_task(id) to get the result. Tip: if the task concerns ' +
          'the project, read its docs first (list_docs / read_doc) and put the ' +
          'relevant context into the prompt, since the fleet only knows what you pass.',
        inputSchema: {
          prompt: z.string().min(1).describe('What to do — full context, since the fleet has none of your project.'),
          title: z.string().max(200).optional().describe('Short title (else derived from the prompt).'),
          agentName: z.string().max(100).optional().describe('Named agent to lead (see list_agents; else the default lead / PM).'),
          references: z.array(z.string()).max(20).optional().describe('Ids of related tasks whose summaries fold into context.'),
        },
      },
      async ({ prompt, title, agentName, references }) => {
        const task = await this.tasks.create({ prompt, title, agentName, references, createdByChannel: 'mcp' });
        followed.add(taskUri(task.id));
        return this.json({
          id: task.id,
          status: task.status,
          title: task.title,
          resource: taskUri(task.id),
          dashboardUrl: `${this.config.dashboardBaseUrl}/tasks/${task.id}`,
        });
      },
    );

    server.registerTool(
      'get_task',
      {
        title: 'Get a task',
        description: 'Current status, latest result summary, PR url, and subtasks of a task.',
        inputSchema: { id: z.string().describe('Task id.') },
      },
      async ({ id }) => {
        followed.add(taskUri(id));
        return this.json(await this.taskView(id));
      },
    );

    server.registerTool(
      'list_tasks',
      {
        title: 'List tasks',
        description: 'Paginated, optionally searched (by title/prompt) list of tasks.',
        inputSchema: {
          q: z.string().optional().describe('Search text over title/prompt.'),
          page: z.number().int().min(1).optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
        },
      },
      async ({ q, page, pageSize }) => {
        const res = await this.tasks.list({ q, page, pageSize });
        return this.json({
          total: res.total,
          page: res.page,
          pageSize: res.pageSize,
          items: res.items.map((t) => ({ id: t.id, title: t.title, status: t.status, parentId: t.parentId })),
        });
      },
    );

    server.registerTool(
      'list_agents',
      {
        title: 'List agents',
        description:
          'List the fleet\'s named agents and their capabilities (description, provider/model, ' +
          'skills, MCP servers, tool limits). Use this to pick the right `agentName` for ' +
          'create_task; omit agentName to use the default lead (PM), which decomposes and delegates.',
        inputSchema: {},
      },
      async () =>
        this.json({
          agents: (await this.agents.list()).map((a) => ({
            ...a,
            // Convenience: true if the agent can't write code (advisory/review).
            readOnly: (a.disallowedTools ?? []).some((t) => /^(Write|Edit|NotebookEdit)$/i.test(t)),
          })),
        }),
    );

    server.registerTool(
      'get_agent',
      {
        title: 'Get an agent',
        description: "Full definition of one named agent, including its instructions (system prompt).",
        inputSchema: { name: z.string().describe('Agent name (see list_agents).') },
      },
      async ({ name }) => this.json(await this.agents.get(name)),
    );

    server.registerTool(
      'follow_up',
      {
        title: 'Follow up on a task',
        description:
          'Send a message into an existing task — to answer a question when the task is ' +
          'awaitingInput (blocked), or to add work/context. Only works once the task has ' +
          'settled (done/blocked/failed/stalled); it resumes the run with your message.',
        inputSchema: { id: z.string(), message: z.string().min(1) },
      },
      async ({ id, message }) => {
        await this.tasks.followUp(id, message);
        followed.add(taskUri(id));
        return this.json({ id, ok: true });
      },
    );

    server.registerTool(
      'cancel_task',
      {
        title: 'Cancel a task',
        description: 'Stop a queued or in-flight task.',
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        const t = await this.tasks.cancel(id);
        return this.json({ id, status: t.status });
      },
    );

    server.registerTool(
      'wait_for_task',
      {
        title: 'Wait for a task to finish',
        description:
          'Block until the task settles (done/failed/cancelled/stalled/blocked, or needs_approval) ' +
          'or the timeout elapses, then return its status + summary + PR. Use this instead of ' +
          'polling — one call that returns when the work is done. If it times out while still ' +
          'running, `timedOut` is true; call again to keep waiting.',
        inputSchema: {
          id: z.string(),
          timeoutSec: z
            .number()
            .int()
            .min(1)
            .max(600)
            .optional()
            .describe('Max seconds to wait (default 120).'),
        },
      },
      async ({ id, timeoutSec }) => this.json(await this.waitForTask(id, timeoutSec ?? 120)),
    );

    server.registerTool(
      'approve_task',
      {
        title: 'Approve a task’s pending request',
        description:
          "Approve the task's pending approval(s) — a needs_approval gate (a dangerous " +
          'action like push/merge, or a continue-after-step-limit prompt). Unblocks the fleet ' +
          'so the run proceeds. Check awaitingApproval / pendingApprovals (each has a `details` ' +
          'field with the command/path) first. Returns `decided` = how many gates were resolved ' +
          '(0 = nothing was pending).',
        inputSchema: { id: z.string() },
      },
      async ({ id }) => this.json(await this.decideApprovals(id, 'approve')),
    );

    server.registerTool(
      'deny_task',
      {
        title: 'Deny a task’s pending request',
        description:
          "Deny the task's pending approval(s). The gated action is refused; a continuation " +
          'prompt denial stops the task (stalled).',
        inputSchema: { id: z.string() },
      },
      async ({ id }) => this.json(await this.decideApprovals(id, 'deny')),
    );

    // Tool mirrors of the doc:// resources — tool-only clients (e.g. claude.ai)
    // can't read MCP resources directly, so expose the same docs as tools.
    server.registerTool(
      'list_docs',
      {
        title: 'List project docs',
        description:
          "List the project repo's markdown docs (the project the fleet works on). " +
          'Use read_doc to fetch one for context before creating tasks.',
        inputSchema: {},
      },
      async () => this.json({ docs: await this.listDocs() }),
    );

    server.registerTool(
      'read_doc',
      {
        title: 'Read a project doc',
        description: 'Return the markdown content of a project doc by its path (see list_docs).',
        inputSchema: {
          path: z.string().describe('Repo-relative path, e.g. "README.md" or "docs/roadmap.md".'),
        },
      },
      async ({ path }) => {
        const { text } = await this.readDoc(path);
        return { content: [{ type: 'text' as const, text }] };
      },
    );

    server.registerResource(
      'task',
      new ResourceTemplate('task://{id}', { list: undefined }),
      { title: 'Fleet task', description: 'Status, summary, PR, and subtasks of a task.' },
      async (uri, variables) => {
        const id = String(variables.id);
        followed.add(taskUri(id));
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(await this.taskView(id), null, 2),
            },
          ],
        };
      },
    );

    server.registerResource(
      'doc',
      new ResourceTemplate('doc://{+path}', {
        list: async () => ({
          resources: (await this.listDocs()).map((p) => ({
            uri: `doc://${p}`,
            name: p,
            title: p,
            mimeType: 'text/markdown',
          })),
        }),
      }),
      {
        title: 'Project documentation',
        description:
          'Markdown docs from the project repo the fleet works on. Read these for ' +
          'context before creating tasks — the fleet works in the same repo.',
      },
      async (uri, variables) => {
        const { text } = await this.readDoc(String(variables.path));
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
      },
    );

    // v1 subscription plumbing: honor explicit subscribe/unsubscribe so clients
    // that use the formal flow work; auto-follow already covers the common case.
    server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
      followed.add(req.params.uri);
      return {};
    });
    server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
      followed.delete(req.params.uri);
      return {};
    });

    return server;
  }

  /** "Stopped making progress" — terminal, or paused for a human (approval). */
  private isSettled(status: TaskStatus): boolean {
    return isTerminalStatus(status) || status === 'needs_approval';
  }

  /**
   * Resolve once a task settles (or the timeout elapses), for the blocking
   * wait_for_task tool — the reliable "is it done yet" path for clients that
   * can't act on push notifications.
   */
  private async waitForTask(
    id: string,
    timeoutSec: number,
  ): Promise<Record<string, unknown>> {
    const view = await this.taskView(id); // 404s if missing
    if (this.isSettled(view.status as TaskStatus)) return { ...view, timedOut: false };

    return new Promise((resolve) => {
      let done = false;
      const finish = async (timedOut: boolean): Promise<void> => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        resolve({ ...(await this.taskView(id)), timedOut });
      };
      const unsubscribe = this.bus.subscribe((event) => {
        if (
          event.type === 'task-status' &&
          event.payload.taskId === id &&
          this.isSettled(event.payload.status)
        ) {
          void finish(false);
        }
      });
      const timer = setTimeout(() => void finish(true), timeoutSec * 1000);
    });
  }

  /** A compact, client-facing view of a task. */
  private async taskView(id: string) {
    const t = await this.tasks.get(id);
    // Latest session carrying a summary — including the auto-generated fallback
    // written on runs that ended without report_task_status (so a stalled/errored
    // task still surfaces *something*, not an empty summary).
    const summary =
      [...t.sessions].reverse().find((s) => s.reportedSummary)?.reportedSummary ?? null;
    const pendingApprovals = t.approvals
      .filter((a) => a.status === 'pending')
      .map((a) => ({
        id: a.id,
        toolName: a.toolName,
        summary: a.summary,
        reason: a.reason,
        // Concrete detail so approve/deny isn't blind: the command/path/args.
        details: approvalDetails(a.toolInput),
      }));
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      prUrl: t.prUrl,
      pushedTo: t.pushedTo,
      error: t.error,
      summary,
      parentId: t.parentId,
      subtasks: t.subtasks.map((s) => ({ id: s.id, title: s.title, status: s.status })),
      // Signals for the client: is the fleet waiting on YOU?
      awaitingInput: t.status === 'blocked', // agent asked a question → follow_up
      awaitingApproval: t.status === 'needs_approval', // gate → approve_task / deny_task
      pendingApprovals,
    };
  }

  /** Approve or deny every pending approval on a task (the needs_approval gate). */
  private async decideApprovals(
    taskId: string,
    decision: 'approve' | 'deny',
  ): Promise<Record<string, unknown>> {
    const task = await this.tasks.get(taskId); // 404s if missing
    const pending = task.approvals.filter((a) => a.status === 'pending');
    for (const a of pending) {
      await this.approvals.decide(a.id, decision, { displayName: 'mcp client' });
    }
    // `decided` = how many pending gates this call resolved. 0 means the task
    // had nothing pending (already settled, or someone else just decided it).
    const message =
      pending.length === 0
        ? 'No pending approval on this task — nothing to decide.'
        : `${decision === 'approve' ? 'Approved' : 'Denied'} ${pending.length} pending gate(s).`;
    return { decided: pending.length, decision, message, ...(await this.taskView(taskId)) };
  }

  private json(value: unknown): { content: { type: 'text'; text: string }[] } {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  }

  /**
   * Enumerate markdown docs under the project repo as POSIX-relative paths.
   * Restricting to `*.md`/`*.mdx` (and skipping hidden/build dirs) keeps this a
   * docs feed — it can't surface source secrets or a stray `.env`.
   */
  private async listDocs(): Promise<string[]> {
    const root = this.config.workspaceRepoPath;
    const out: string[] = [];
    let scanned = 0;

    const walk = async (dir: string): Promise<void> => {
      if (out.length >= DOC_MAX_FILES || scanned >= DOC_MAX_SCAN) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip
      }
      for (const e of entries) {
        if (out.length >= DOC_MAX_FILES || scanned >= DOC_MAX_SCAN) return;
        scanned++;
        if (e.name.startsWith('.')) continue; // hidden files/dirs (incl. .env)
        if (e.isDirectory()) {
          if (!DOC_SKIP_DIRS.has(e.name)) await walk(join(dir, e.name));
        } else if (e.isFile() && /\.mdx?$/i.test(e.name)) {
          out.push(relative(root, join(dir, e.name)).split(sep).join('/'));
        }
      }
    };

    await walk(root);
    out.sort();
    return out;
  }

  /** Read one doc, confined to the repo and to markdown, size-capped. */
  private async readDoc(rel: string): Promise<{ text: string; truncated: boolean }> {
    const root = resolve(this.config.workspaceRepoPath);
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error('Path is outside the project');
    if (!/\.mdx?$/i.test(abs)) throw new Error('Only markdown docs are exposed');
    const info = await stat(abs);
    if (!info.isFile()) throw new Error('Not a file');
    let text = await readFile(abs, 'utf8');
    let truncated = false;
    if (text.length > DOC_MAX_BYTES) {
      text = `${text.slice(0, DOC_MAX_BYTES)}\n\n…[truncated]`;
      truncated = true;
    }
    return { text, truncated };
  }
}
