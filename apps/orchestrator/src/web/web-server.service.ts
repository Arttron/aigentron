import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import { AccessService } from '../access/access.service';
import { AppConfigService } from '../config/app-config.service';
import { EventsGateway } from '../events/events.gateway';
import {
  DEFAULT_WEB_CONFIG,
  inspectCertificate,
  parseWebConfig,
  redirectTarget,
  type CertInfo,
  type WebServerConfig,
} from './web-server-core';

type Kind = 'http' | 'https';
export interface ListenerStatus {
  kind: Kind;
  port: number;
  state: 'listening' | 'off' | 'error';
  /** What this listener does: serve the app, or redirect to HTTPS. */
  role?: 'app' | 'redirect';
  error?: string;
}

/**
 * The server's own web listeners besides the API port (3001, which is always there): plain HTTP on 80 only when switched on; with a
 * certificate installed, HTTPS on 443, and port 80 (if on) becomes a redirect to HTTPS (for domain names). The domain allow-list and
 * Cloudflare Access checks live in the shared Express app, so every listener enforces them. A port that cannot be bound
 * (taken, or no permission for ports below 1024) is reported, never fatal. Config: `<secrets>/web-server.json`; the
 * certificate: `<secrets>/tls/fullchain.pem` + `privkey.pem` (0600).
 */
@Injectable()
export class WebServerService {
  private readonly logger = new Logger('WebServer');
  private servers: { http?: HttpServer; https?: HttpsServer } = {};
  private listeners: ListenerStatus[] = [];
  private applied = '';
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: AppConfigService,
    private readonly access: AccessService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get configFile(): string {
    return join(this.config.secretsDir, 'web-server.json');
  }
  private get tlsDir(): string {
    return join(this.config.secretsDir, 'tls');
  }
  private get certFile(): string {
    return join(this.tlsDir, 'fullchain.pem');
  }
  private get keyFile(): string {
    return join(this.tlsDir, 'privkey.pem');
  }

  /**
   * Defaults. With ORCHESTRATOR_HOST=127.0.0.1 ("this machine only", i.e. a reverse proxy or tunnel on the same host) nothing is opened on
   * 80/443 unless asked for — a proxy there needs those ports, and binding them here would get in its way.
   */
  private defaults(): WebServerConfig {
    const local = ['127.0.0.1', 'localhost', '::1'].includes(process.env.ORCHESTRATOR_HOST?.trim() ?? '');
    return local ? { ...DEFAULT_WEB_CONFIG, httpsPort: 0 } : DEFAULT_WEB_CONFIG;
  }

  getConfig(): WebServerConfig {
    try {
      const r = parseWebConfig(JSON.parse(readFileSync(this.configFile, 'utf8')), this.config.port, this.defaults());
      if (r.ok) return r.config;
    } catch {
      /* no file yet */
    }
    return this.defaults();
  }

  /** The installed certificate, if any (and valid). */
  certificate(): { info: CertInfo | null; error?: string; present: boolean } {
    if (!existsSync(this.certFile) || !existsSync(this.keyFile)) return { present: false, info: null };
    const r = inspectCertificate(readFileSync(this.certFile, 'utf8'), readFileSync(this.keyFile, 'utf8'));
    return r.ok ? { present: true, info: r.info } : { present: true, info: null, error: r.error };
  }

  status() {
    const cert = this.certificate();
    const hosts = this.access.effective();
    return {
      apiPort: this.config.port,
      config: this.getConfig(),
      listeners: this.listeners,
      certificate: cert.info,
      certificateError: cert.error ?? null,
      // domains the user allows that the certificate does not cover (a browser would warn)
      uncoveredDomains: cert.info ? hosts.filter((h) => !h.startsWith('*') && !cert.info!.names.some((n) => this.covers(n, h))) : [],
    };
  }

  private covers(name: string, host: string): boolean {
    return name === host || (name.startsWith('*.') && host.endsWith(name.slice(1)) && !host.slice(0, -name.slice(1).length).includes('.'));
  }

  /** (Re)bind the listeners to match the config and certificate. Serialized; safe to call again. */
  apply(): Promise<void> {
    this.chain = this.chain.then(() => this.doApply()).catch((e) => this.logger.error(`apply failed: ${(e as Error).message}`));
    return this.chain as Promise<void>;
  }

  private expressApp(): (req: IncomingMessage, res: ServerResponse) => void {
    return this.adapterHost.httpAdapter.getInstance() as (req: IncomingMessage, res: ServerResponse) => void;
  }

  private async doApply(): Promise<void> {
    const cfg = this.getConfig();
    const cert = this.certificate();
    const tls = cert.present && cert.info ? { cert: readFileSync(this.certFile), key: readFileSync(this.keyFile) } : null;
    if (cert.present && !cert.info) this.logger.warn(`The installed certificate is unusable: ${cert.error}`);
    const fingerprint = JSON.stringify([cfg, tls ? [tls.cert.length, cert.info?.validTo] : null]);
    if (fingerprint === this.applied && this.listeners.length) return;
    this.applied = fingerprint;
    await Promise.all([this.close('http'), this.close('https')]);
    this.listeners = [];
    const app = this.expressApp();

    // HTTP
    if (cfg.httpPort) {
      const redirecting = Boolean(tls) && cfg.redirect && cfg.httpsPort > 0;
      const handler = redirecting
        ? (req: IncomingMessage, res: ServerResponse) => {
            // a domain that is not allowed gets the same 421 as everywhere; allowed domains are sent to HTTPS
            const to = redirectTarget(req.headers.host, req.url ?? '/', cfg.httpsPort);
            if (to && this.access.allows(req.headers.host)) {
              res.writeHead(308, { location: to, 'cache-control': 'no-store' }).end();
            } else app(req, res);
          }
        : app;
      this.listeners.push(await this.listen('http', cfg.httpPort, createHttpServer(handler), redirecting ? 'redirect' : 'app'));
    } else this.listeners.push({ kind: 'http', port: 0, state: 'off' });

    // HTTPS
    if (tls && cfg.httpsPort) {
      this.listeners.push(await this.listen('https', cfg.httpsPort, createHttpsServer({ ...tls, minVersion: 'TLSv1.2' }, app), 'app'));
    } else this.listeners.push({ kind: 'https', port: 0, state: 'off' });
  }

  private async listen<S extends HttpServer | HttpsServer>(kind: Kind, port: number, server: S, role: 'app' | 'redirect'): Promise<ListenerStatus> {
    const host = process.env.WEB_HOST?.trim() || '0.0.0.0';
    return new Promise((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        const hint = e.code === 'EACCES' ? ' (ports below 1024 need root or CAP_NET_BIND_SERVICE)' : e.code === 'EADDRINUSE' ? ' (another program already uses it)' : '';
        const error = `${e.code ?? e.message}${hint}`;
        this.logger.warn(`${kind.toUpperCase()} port ${port}: ${error}`);
        resolve({ kind, port, state: 'error', role, error });
      });
      server.listen(port, host, () => {
        server.removeAllListeners('error');
        server.on('error', (e) => this.logger.warn(`${kind} server error: ${e.message}`));
        this.servers[kind] = server as never;
        // live updates (Socket.IO) on this listener too
        try {
          this.moduleRef.get(EventsGateway, { strict: false }).server.attach(server as HttpServer);
        } catch (e) {
          this.logger.warn(`could not attach live updates to :${port}: ${(e as Error).message}`);
        }
        this.logger.log(`${kind.toUpperCase()} ${role === 'redirect' ? 'redirect to HTTPS' : 'app'} listening on :${port}`);
        resolve({ kind, port, state: 'listening', role });
      });
    });
  }

  private async close(kind: Kind): Promise<void> {
    const s = this.servers[kind];
    if (!s) return;
    delete this.servers[kind];
    await new Promise<void>((r) => {
      s.close(() => r());
      s.closeAllConnections?.();
    });
  }

  async start(): Promise<void> {
    await this.apply();
  }

  // ---- changes (each re-binds the listeners) ----

  async setConfig(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = parseWebConfig(input, this.config.port, this.getConfig());
    if (!r.ok) return r;
    this.write(this.configFile, JSON.stringify(r.config));
    await this.apply();
    return { ok: true };
  }

  async setCertificate(certPem: unknown, keyPem: unknown): Promise<{ ok: true; info: CertInfo } | { ok: false; error: string }> {
    if (typeof certPem !== 'string' || typeof keyPem !== 'string' || !certPem.trim() || !keyPem.trim()) return { ok: false, error: 'Give both the certificate and the private key (PEM text).' };
    const r = inspectCertificate(certPem, keyPem);
    if (!r.ok) return r;
    mkdirSync(this.tlsDir, { recursive: true, mode: 0o700 });
    this.write(this.certFile, `${certPem.trim()}\n`);
    this.write(this.keyFile, `${keyPem.trim()}\n`);
    await this.apply();
    return { ok: true, info: r.info };
  }

  async removeCertificate(): Promise<void> {
    rmSync(this.certFile, { force: true });
    rmSync(this.keyFile, { force: true });
    await this.apply();
  }

  private write(file: string, data: string): void {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
}
