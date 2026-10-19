import { lookup } from 'node:dns/promises';
import type { Server as HttpServer } from 'node:http';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import { AccessService } from '../access/access.service';
import { CloudflareAccessService } from '../access/cloudflare-access.service';
import { AuthService } from '../auth/auth.service';
import { AppConfigService } from '../config/app-config.service';
import { EventsGateway } from '../events/events.gateway';
import { UsersService } from '../users/users.service';
import { AddonsService } from './addons.service';
import { ViewProxy } from './view-proxy';

/**
 * Wires the view proxy (view-proxy.ts) to the real services and to every listener of this process: the API port at
 * bootstrap, and the 80/443 listeners as web/web-server.service.ts binds them (it attaches the live-updates socket to each,
 * so that call is the hook — the proxy follows wherever Socket.IO is attached).
 */
@Injectable()
export class AddonsViewProxyService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Addons');
  readonly proxy: ViewProxy;
  private trusted: { at: number; ips: string[] } = { at: 0, ips: [] };

  constructor(
    config: AppConfigService,
    addons: AddonsService,
    auth: AuthService,
    users: UsersService,
    access: AccessService,
    cloudflare: CloudflareAccessService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly moduleRef: ModuleRef,
  ) {
    this.proxy = new ViewProxy(
      { auth, users, access, cloudflare, endpoint: () => addons.viewEndpoint('browser') },
      {
        maxSessions: config.addonViewMaxSessions,
        sessionMs: config.addonViewSessionMinutes * 60_000,
        trustedProxies: () => this.trustedPeers(),
        trustCloudflare: !/^(0|false|no)$/i.test(process.env.TRUST_CLOUDFLARE ?? ''),
      },
    );
    addons.activeViewers = () => this.proxy.sessions.count;
  }

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer?.() as HttpServer | undefined;
    if (server) this.proxy.attach(server);
    try {
      const io = this.moduleRef.get(EventsGateway, { strict: false })?.server;
      if (!io) return;
      const original = io.attach.bind(io);
      io.attach = ((srv, opts) => {
        const r = original(srv, opts);
        if (typeof srv === 'object' && srv) this.proxy.attach(srv as HttpServer);
        return r;
      }) as typeof io.attach;
    } catch (e) {
      this.logger.warn(`the browser view follows the API port only (no live-updates gateway to ride on): ${(e as Error).message}`);
    }
  }

  /** As the sign-in does (auth.controller.ts): TRUSTED_PROXY plus the compose stack's `cloudflared`; Cloudflare's own ranges are built in. */
  private async trustedPeers(): Promise<string[]> {
    if (Date.now() - this.trusted.at < 60_000) return this.trusted.ips;
    const fromEnv = (process.env.TRUSTED_PROXY ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const resolved = await lookup('cloudflared', { all: true }).then((r) => r.map((x) => x.address)).catch(() => []);
    this.trusted = { at: Date.now(), ips: [...fromEnv, ...resolved] };
    return this.trusted.ips;
  }
}
