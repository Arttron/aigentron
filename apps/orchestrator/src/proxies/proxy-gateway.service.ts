import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { createGateway, fetchThrough, type Gateway } from './gateway';
import { ProxyStore, type ProxyView } from './proxy-store';

/** The saved proxy connections, and the gateway the browser goes through (docs/browser-proxy.md). */
@Injectable()
export class ProxyGatewayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProxyGatewayService.name);
  readonly store: ProxyStore;
  private server?: Gateway;

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

  list(): { items: ProxyView[]; gateway: { port: number; listening: boolean }; agentsCanSwitch: boolean; activeBy: { by: string; at: string } | null } {
    return { items: this.store.list(), gateway: { port: this.config.proxyGatewayPort, listening: Boolean(this.server?.listening) }, agentsCanSwitch: this.store.agentsCanSwitch(), activeBy: this.store.activeBy() };
  }

  /** Choose the connection (null = direct) and drop the open connections, so that the browser's kept-alive tunnels do not go on through the old one. */
  choose(id: string | null, by = 'you'): boolean {
    if (!this.store.setActive(id, by)) return false;
    this.server?.flush();
    return true;
  }

  /** For an agent: the saved proxies by name (never a login), and which one is in use. */
  agentList(): string {
    const items = this.store.list();
    const head = this.store.agentsCanSwitch() ? 'You may switch the browser to one of these with browser_proxy_use.' : 'The operator did not allow agents to switch the browser proxy: browser_proxy_use is refused.';
    if (!items.length) return `No proxies are saved (the browser goes direct). ${head}`;
    const by = this.store.activeBy();
    return [
      `In use now: ${items.find((i) => i.active)?.name ?? 'direct (the server\'s own address)'}${by ? ` (chosen by ${by.by})` : ''}. ${head}`,
      ...items.map((i) => `- ${i.name} — ${i.server.replace(/^http:\/\//, '')}${i.active ? '  ← in use' : ''}`),
      'The choice is shared by every task that uses the server\'s browser.',
    ].join('\n');
  }

  /** An agent chooses a proxy by name (or "direct"). Throws a readable reason when it may not or the name is unknown. */
  agentUse(name: string, taskId: string): string {
    if (!this.store.agentsCanSwitch()) throw new Error('the operator did not allow agents to switch the browser proxy (Add-ons → Playwright → Browser proxy).');
    const n = name.trim();
    if (!n) throw new Error('give the name of a saved proxy, or "direct".');
    if (/^(direct|none|off)$/i.test(n)) {
      this.choose(null, `agent (task ${taskId})`);
      return 'The browser now connects directly (no proxy). Reload the page: connections that were open were closed.';
    }
    const item = this.store.byName(n);
    if (!item) throw new Error(`no saved proxy named "${n}". Names: ${this.store.list().map((i) => i.name).join(', ') || '(none)'}.`);
    this.choose(item.id, `agent (task ${taskId})`);
    this.logger.log(`Task ${taskId} switched the browser to proxy "${item.name}"`);
    return `The browser now goes through "${item.name}" (${item.server.replace(/^http:\/\//, '')}). Open connections were closed: navigate again. The choice is shared by every task using the server's browser; set it back to the one you found (or "direct") when you are done, unless the person asked otherwise.`;
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
