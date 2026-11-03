import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AuthService } from './auth.service';
import { SessionsService } from './sessions.service';
import { ExtensionDevicesService } from './extension-devices.service';
import { looksLikeDeviceToken } from './extension-devices';
import { ownAddresses } from '../access/own-addresses';
import { extensionRouteAllowed } from '../extension/extension-pairing';
import { isDirectLocalRequest, isMachineRoute, isPublicRoute, tokenFromRequest } from './auth-core';

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
    private readonly sessions: SessionsService,
    private readonly devices: ExtensionDevicesService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<{
      path: string;
      method: string;
      headers: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
      authUserId?: string;
      extensionDeviceId?: string;
    }>();
    const path = req.path.replace(/\/+$/, '') || '/';
    if (isPublicRoute(path)) return true;
    // A browser extension has its own credential (a device token), checked whether or not the server has a sign-in password. It reaches only its own
    // few routes, whatever its user's role would allow, and acts as the user that paired it.
    const bearer = tokenFromRequest(req.headers);
    if (looksLikeDeviceToken(bearer)) {
      const reported = req.headers['x-extension-version'];
      const access = req.headers['x-extension-access'];
      const device = this.devices.verify(bearer, Array.isArray(reported) ? reported[0] : reported, Array.isArray(access) ? access[0] : access);
      if (!device) throw new UnauthorizedException('The extension is not (or no longer) connected to this server.');
      if (!extensionRouteAllowed(req.method, path)) throw new ForbiddenException('This token (a browser extension) cannot use this route.');
      req.authUserId = device.userId;
      req.extensionDeviceId = device.id;
      return true;
    }
    if (!this.auth.isConfigured()) return true;
    const uid = this.auth.sessionUserId(req.headers);
    if (uid) {
      req.authUserId = uid; // RolesGuard acts as THIS user — the x-lds-user header is ignored once sign-in is on
      this.sessions.touch(this.auth.sessionIdOf(req.headers));
      return true;
    }
    if (isMachineRoute(path) && isDirectLocalRequest(req.socket?.remoteAddress, ownAddresses(), req.headers)) return true;
    // The MCP entry point for outside clients has its own token check inside the handler.
    if (path === '/api/mcp' && this.config.mcpToken) return true;
    throw new UnauthorizedException('Sign in required.');
  }
}
