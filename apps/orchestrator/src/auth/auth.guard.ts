import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AuthService } from './auth.service';
import { networkInterfaces } from 'node:os';
import { isMachineRoute, isPublicRoute, isThisMachine } from './auth-core';

/** This host's own addresses, re-read at most every 30s (interfaces rarely change). */
let ownCache: { at: number; list: string[] } = { at: 0, list: [] };
function ownAddresses(): string[] {
  if (Date.now() - ownCache.at > 30_000) {
    ownCache = { at: Date.now(), list: Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((i) => i.address)) };
  }
  return ownCache.list;
}

/**
 * Global gate. When a sign-in password is set, every /api route needs a valid session — except liveness + the sign-in
 * endpoints, the agent-facing "machine" routes (own credential, and only from this machine), and the MCP entry point
 * when it has its own MCP_TOKEN. Before a password exists nothing changes.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    if (!this.auth.isConfigured()) return true;
    const req = context.switchToHttp().getRequest<{
      path: string;
      headers: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
      authUserId?: string;
    }>();
    const path = req.path.replace(/\/+$/, '') || '/';
    if (isPublicRoute(path)) return true;
    const uid = this.auth.sessionUserId(req.headers);
    if (uid) {
      req.authUserId = uid; // RolesGuard acts as THIS user — the x-lds-user header is ignored once sign-in is on
      return true;
    }
    if (isMachineRoute(path) && isThisMachine(req.socket?.remoteAddress, ownAddresses())) return true;
    // The MCP entry point for outside clients has its own token check inside the handler.
    if (path === '/api/mcp' && this.config.mcpToken) return true;
    throw new UnauthorizedException('Sign in required.');
  }
}
