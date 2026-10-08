import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildInternalToolSpecs, type InternalToolHandlers, type InternalToolSpec } from '@lds/agent-runner';
import { AppConfigService } from '../config/app-config.service';

interface Run {
  specs: InternalToolSpec[];
}

/**
 * Serves an agent run's internal control-plane tools (report_task_status, heartbeat,
 * create_subtask, admin tools, …) over HTTP MCP, for runtimes that can't host
 * in-process tools the way the Claude Agent SDK does (Codex). Each run registers its
 * handler closures under a random bearer token; the token only works while the run is
 * live and only reaches THAT run's handlers, so the endpoint can't be used to drive
 * another task. Stateless Streamable HTTP: a fresh server + transport per request.
 */
@Injectable()
export class InternalMcpService {
  private readonly logger = new Logger(InternalMcpService.name);
  private readonly runs = new Map<string, Run>();

  constructor(private readonly config: AppConfigService) {}

  /** Register a live run's handlers; call `dispose()` when the run ends. */
  register(handlers: InternalToolHandlers): { url: string; token: string; dispose: () => void } {
    const token = randomBytes(24).toString('hex');
    this.runs.set(token, { specs: buildInternalToolSpecs(handlers) });
    return {
      url: `${this.config.approvalsApiUrl.replace(/\/$/, '')}/api/internal-mcp`,
      token,
      dispose: () => {
        this.runs.delete(token);
      },
    };
  }

  /** Names of the tools a registered run exposes (diagnostics/tests). */
  toolNames(token: string): string[] {
    return this.runs.get(token)?.specs.map((s) => s.name) ?? [];
  }

  private lookup(req: Request): Run | null {
    const header = req.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided) return null;
    const a = Buffer.from(provided);
    for (const [token, run] of this.runs) {
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return run;
    }
    return null;
  }

  async handle(req: Request, res: Response): Promise<void> {
    const run = this.lookup(req);
    if (!run) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    if (req.method !== 'POST') {
      // Stateless mode has no SSE stream or sessions to manage.
      res.status(405).set('Allow', 'POST').send('Method Not Allowed');
      return;
    }
    const server = new McpServer({ name: 'lds-internal', version: '1.0.0' });
    for (const spec of run.specs) {
      server.registerTool(spec.name, { description: spec.description, inputSchema: spec.shape }, async (args) => {
        try {
          return { content: [{ type: 'text' as const, text: await spec.handler(args as Record<string, unknown>) }] };
        } catch (err) {
          this.logger.warn(`internal tool ${spec.name} failed: ${(err as Error).message}`);
          return { isError: true, content: [{ type: 'text' as const, text: (err as Error).message }] };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
