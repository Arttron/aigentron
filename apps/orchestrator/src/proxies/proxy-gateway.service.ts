import type { Server } from 'node:http';
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { createGateway, fetchThrough } from './gateway';
import { ProxyStore, type ProxyView } from './proxy-store';

/** The saved proxy connections, and the gateway the browser goes through (docs/browser-proxy.md). */
@Injectable()
export class ProxyGatewayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProxyGatewayService.name);
  readonly store: ProxyStore;
  private server?: Server;

  constructor(private readonly config: AppConfigService) {
    this.store = new ProxyStore(join(config.secretsDir, 'proxies.json'));
  }

  onApplicationBootstrap(): void {
    const port = this.config.proxyGatewayPort;
    if (!port) return;
    const server = createGateway({ upstream: () => this.store.active(), log: (m) => this.logger.debug(m) });
    server.on('error', (e) => this.logger.warn(`the browser gateway could not start on ${this.config.proxyGatewayBind}:${port}: ${(e as Error).message}`));
    server.listen(port, this.config.proxyGatewayBind, () => this.logger.log(`Browser gateway on ${this.config.proxyGatewayBind}:${port} (${this.store.active() ? `through "${this.store.active()!.name}"` : 'direct'})`));
    this.server = server;
  }

  onModuleDestroy(): void {
    this.server?.close();
  }

  list(): { items: ProxyView[]; gateway: { port: number; listening: boolean } } {
    return { items: this.store.list(), gateway: { port: this.config.proxyGatewayPort, listening: Boolean(this.server?.listening) } };
  }

  /** What address do sites see through this connection? */
  async test(id: string): Promise<{ ok: boolean; ip?: string; ms?: number; error?: string }> {
    const item = this.store.get(id);
    if (!item) return { ok: false, error: 'no such proxy' };
    const t0 = Date.now();
    try {
      const ip = await fetchThrough(item, 'http://api.ipify.org/');
      return { ok: true, ip, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
