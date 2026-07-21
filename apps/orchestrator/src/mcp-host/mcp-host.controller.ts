import { timingSafeEqual } from 'node:crypto';
import { All, Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpHostService } from './mcp-host.service';
import { AppConfigService } from '../config/app-config.service';

/**
 * MCP entry point for external clients, at `/api/mcp` (Streamable HTTP):
 *   - POST   → JSON-RPC requests, incl. the initialize handshake
 *   - GET    → SSE stream for server→client pushes (resources/updated)
 *   - DELETE → session teardown
 *
 * One handler dispatches by method so the transport owns the protocol details.
 * Disabled (404) when MCP_HOST_ENABLED is off.
 */
@Controller('mcp')
export class McpHostController {
  constructor(
    private readonly host: McpHostService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Dashboard-facing status (no MCP token needed — this is the app's own UI).
   * Deliberately never returns the token value, only whether one is required.
   */
  @Get('status')
  status() {
    return {
      enabled: this.config.mcpHostEnabled,
      tokenRequired: Boolean(this.config.mcpToken),
      allowedOrigins: this.config.mcpAllowedOrigins,
      activeSessions: this.host.activeSessions(),
      path: '/api/mcp',
    };
  }

  @All()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!this.config.mcpHostEnabled) {
      res.status(404).send('MCP host disabled');
      return;
    }
    if (!this.authorized(req)) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: missing or invalid MCP token.' },
        id: null,
      });
      return;
    }
    switch (req.method) {
      case 'POST':
        return this.host.handlePost(req, res);
      case 'GET':
        return this.host.handleGet(req, res);
      case 'DELETE':
        return this.host.handleDelete(req, res);
      default:
        res.status(405).send('Method Not Allowed');
    }
  }

  /**
   * Token gate. Off when MCP_TOKEN is unset (localhost v1 posture). When set,
   * the token may arrive as `Authorization: Bearer <t>` or a `?key=<t>` query
   * param — the latter lets it be baked into a claude.ai connector URL, which
   * has no way to attach custom headers.
   */
  private authorized(req: Request): boolean {
    const expected = this.config.mcpToken;
    if (!expected) return true;
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const query = typeof req.query.key === 'string' ? req.query.key : undefined;
    const provided = bearer ?? query ?? '';
    // Constant-time compare; length-mismatch short-circuits (still safe).
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
