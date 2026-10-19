import { request as httpRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { Logger } from '@nestjs/common';
import { clientAddress } from '../auth/auth-core';
import {
  ViewSessions,
  formatDuration,
  forwardRequestHeaders,
  isViewPath,
  rawHttpAnswer,
  responseHeaders,
  upgradeResponseHeaders,
  upstreamPath,
  wsCloseFrame,
  type Endpoint,
} from './addons-core';

export interface ProxyUser {
  id: string;
  displayName: string;
  role: string;
}
type AuthResult = { ok: true; user: ProxyUser } | { ok: false; status: 401 | 403; message: string };

/** The slice of the real services the proxy uses (the integration test hands in small fakes). */
export interface ProxyDeps {
  auth: { isConfigured(): boolean; sessionUserId(headers: IncomingMessage['headers']): string | null };
  users: { getRow(id: string): Promise<ProxyUser>; defaultOperator(): Promise<ProxyUser> };
  access: { allowsRequest(host: string | undefined, peer: string | undefined, headers: IncomingMessage['headers']): boolean };
  cloudflare: { required(host: string | undefined): boolean; check(headers: IncomingMessage['headers']): Promise<{ ok: boolean }> };
  /** The enabled add-on's view endpoint right now (re-read per request: `aigentron addon disable` takes effect at once). */
  endpoint(): Promise<Endpoint | null>;
}

export interface ViewProxyOptions {
  maxSessions: number;
  sessionMs: number;
  /** Peers whose `cf-connecting-ip` is believed (for the audit line only). */
  trustedProxies?: () => Promise<readonly string[]>;
  trustCloudflare?: boolean;
  upstreamTimeoutMs?: number;
  logger?: Pick<Logger, 'log' | 'warn'>;
}

const VIEW_ROLES: readonly string[] = ['operator', 'admin'];
const LOGS_HINT = 'On the server: aigentron addon logs browser';

/**
 * The browser add-on's view proxy: `GET /api/addons/browser/view/*` (the noVNC page and its files) and the WebSocket under
 * it (the VNC stream) are relayed to the add-on's loopback endpoint — which has no sign-in of its own — behind the
 * dashboard's: the domain allow-list, Cloudflare Access (when on), the session cookie, and the operator/admin role (whoever
 * watches can also type into the browser). Cookies and tokens never reach the add-on; its answers get framing-restricted.
 * Streams are capped (`maxSessions` at once) and time-limited (`sessionMs`); each open/close is logged with who/when/from.
 * Plain node:http on purpose — nothing else is a dependency, and this is a one-upstream relay, not a general proxy.
 */
export class ViewProxy {
  readonly sessions: ViewSessions;
  private readonly logger: Pick<Logger, 'log' | 'warn'>;
  private readonly attached = new WeakSet<HttpServer>();

  constructor(
    private readonly deps: ProxyDeps,
    private readonly opts: ViewProxyOptions,
  ) {
    this.sessions = new ViewSessions(opts.maxSessions, opts.sessionMs);
    this.logger = opts.logger ?? new Logger('Addons');
  }

  /**
   * Take the view path's `upgrade` events on this listener. Socket.IO's engine ends any upgrade it did not handle after a
   * second (`destroyUpgrade`), so the existing listeners are wrapped: our path comes here, everything else goes on to them.
   */
  attach(server: HttpServer): void {
    if (this.attached.has(server)) return;
    this.attached.add(server);
    const previous = server.listeners('upgrade') as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
    server.removeAllListeners('upgrade');
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (isViewPath(req.url)) {
        void this.handleUpgrade(req, socket, head);
        return;
      }
      for (const l of previous) l.call(server, req, socket, head);
    });
  }

  /** The same gate for a page request and for the WebSocket handshake. */
  async authorize(req: IncomingMessage): Promise<AuthResult> {
    const h = req.headers;
    const host = h.host;
    if (!this.deps.access.allowsRequest(host, req.socket?.remoteAddress, h)) return { ok: false, status: 403, message: 'This address is not served here.' };
    if (this.deps.cloudflare.required(host) && !(await this.deps.cloudflare.check(h)).ok) {
      return { ok: false, status: 403, message: 'Cloudflare Access sign-in is required for this address.' };
    }
    let user: ProxyUser;
    if (this.deps.auth.isConfigured()) {
      const uid = this.deps.auth.sessionUserId(h);
      if (!uid) return { ok: false, status: 401, message: 'Sign in required.' };
      try {
        user = await this.deps.users.getRow(uid);
      } catch {
        return { ok: false, status: 403, message: 'Your account no longer exists' };
      }
    } else {
      // sign-in off: the acting-user header (the dashboard's switcher) or the default operator — as RolesGuard does
      const raw = h['x-lds-user'];
      const id = (Array.isArray(raw) ? raw[0] : raw)?.trim();
      try {
        user = id ? await this.deps.users.getRow(id) : await this.deps.users.defaultOperator();
      } catch {
        return { ok: false, status: 403, message: 'Unknown acting user' };
      }
    }
    if (!VIEW_ROLES.includes(user.role)) return { ok: false, status: 403, message: `Requires role: operator | admin (you are ${user.role})` };
    return { ok: true, user: { id: user.id, displayName: user.displayName, role: user.role } };
  }

  /** The page and its files. Only GET/HEAD: the add-on is a static server plus a socket; nothing is ever posted to it. */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      text(res, 405, 'Only GET.', { allow: 'GET, HEAD' });
      return;
    }
    const a = await this.authorize(req);
    if (!a.ok) {
      text(res, a.status, a.message);
      return;
    }
    const ep = await this.deps.endpoint();
    if (!ep) {
      text(res, 404, 'The browser add-on is not enabled on this server.');
      return;
    }
    const path = upstreamPath(fullUrl(req));
    if (path === null) {
      text(res, 400, 'Bad path.');
      return;
    }
    const up = httpRequest(
      { host: ep.hostname, port: ep.port, method, path: ep.basePath + path, headers: forwardRequestHeaders(req.headers, hostHeader(ep)), timeout: this.opts.upstreamTimeoutMs ?? 15_000 },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, responseHeaders(ur.headers));
        if (method === 'HEAD') {
          ur.resume();
          res.end();
          return;
        }
        ur.pipe(res);
      },
    );
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', (e) => {
      if (!res.headersSent) text(res, 502, `The browser view is not answering (${describe(e)}). ${LOGS_HINT}`);
      else res.destroy();
    });
    res.on('close', () => up.destroy());
    up.end();
  }

  /** The VNC stream: authenticate the handshake, forward it, then pipe bytes both ways until one side ends or time is up. */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => undefined);
    const refuse = (status: number, message: string) => {
      if (!socket.destroyed) socket.end(rawHttpAnswer(status, message));
    };
    let a: AuthResult;
    try {
      a = await this.authorize(req);
    } catch (e) {
      refuse(503, `Could not check the sign-in: ${(e as Error).message}`);
      return;
    }
    if (!a.ok) {
      refuse(a.status, a.message);
      return;
    }
    const ep = await this.deps.endpoint();
    if (!ep) {
      refuse(404, 'The browser add-on is not enabled on this server.');
      return;
    }
    const path = upstreamPath(fullUrl(req));
    if (path === null) {
      refuse(400, 'Bad path.');
      return;
    }
    if (socket.destroyed) return;
    const from = await this.clientAddress(req);
    const who = `${a.user.displayName} (${a.user.role}) from ${from}`;
    const session = this.sessions.open({ userId: a.user.id, userName: a.user.displayName, role: a.user.role, from });
    if (!session) {
      this.logger.warn(`browser view refused for ${who}: ${this.sessions.max} already watching`);
      refuse(503, `Too many viewers: at most ${this.sessions.max} at once. Try again later.`);
      return;
    }
    this.logger.log(`browser view opened by ${who} — ${this.sessions.count}/${this.sessions.max} watching, ends in ${formatDuration(this.sessions.limitMs)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let opened = false;
    const finish = (reason: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.sessions.close(session.id);
      this.logger.log(`browser view closed for ${who} after ${formatDuration(Date.now() - session.openedAt)} (${reason}) — ${this.sessions.count}/${this.sessions.max} watching`);
    };

    const up = httpRequest({ host: ep.hostname, port: ep.port, method: 'GET', path: ep.basePath + path, headers: forwardRequestHeaders(req.headers, hostHeader(ep), true), timeout: this.opts.upstreamTimeoutMs ?? 15_000 });
    up.on('upgrade', (ur, upSocket, upHead) => {
      upSocket.on('error', () => undefined);
      if (socket.destroyed) {
        upSocket.destroy();
        finish('the browser went away during the handshake');
        return;
      }
      opened = true;
      const lines = Object.entries(upgradeResponseHeaders(ur.headers)).map(([k, v]) => `${k}: ${v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      socket.pipe(upSocket);
      upSocket.pipe(socket);
      // an HTTP server's sockets stay half-open after the peer's FIN (keep-alive); a VNC stream that lost one direction is over
      socket.on('end', () => socket.destroy());
      upSocket.on('end', () => upSocket.destroy());
      socket.on('close', () => {
        upSocket.destroy();
        finish('closed by the viewer');
      });
      upSocket.on('close', () => {
        socket.destroy();
        finish('closed by the add-on');
      });
      timer = setTimeout(() => {
        // tell the browser why, then end both sides (noVNC shows the reason; the dashboard offers a new session)
        upSocket.unpipe(socket);
        socket.write(wsCloseFrame(1000, 'Session time is over'));
        socket.end();
        upSocket.destroy();
        finish('time limit');
      }, this.sessions.remaining(session));
    });
    up.on('response', (ur) => {
      // the add-on answered a plain HTTP response instead of switching protocols
      ur.resume();
      refuse(502, `The browser view refused the stream (HTTP ${ur.statusCode}). ${LOGS_HINT}`);
      finish(`the add-on answered HTTP ${ur.statusCode}`);
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', (e) => {
      refuse(502, `The browser view is not answering (${describe(e)}). ${LOGS_HINT}`);
      finish(`add-on error: ${describe(e)}`);
    });
    socket.on('close', () => {
      // registered first, so it also runs first once the stream is open — the listeners above own that case
      if (!done && !opened) {
        up.destroy();
        finish('the browser went away before the stream opened');
      }
    });
    up.end();
  }

  private async clientAddress(req: IncomingMessage): Promise<string> {
    const cf = req.headers['cf-connecting-ip'];
    const peers = this.opts.trustedProxies ? await this.opts.trustedProxies().catch(() => []) : [];
    return clientAddress(Array.isArray(cf) ? cf[0] : cf, req.socket?.remoteAddress || 'unknown', peers, this.opts.trustCloudflare ?? true);
  }
}

/** Express rewrites `req.url` under a router; the original is what the view prefix is matched against. */
function fullUrl(req: IncomingMessage): string {
  return (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
}

function hostHeader(ep: Endpoint): string {
  const h = ep.hostname.includes(':') ? `[${ep.hostname}]` : ep.hostname;
  return ep.port === 80 ? h : `${h}:${ep.port}`;
}

function describe(e: Error): string {
  return (e as NodeJS.ErrnoException).code ?? e.message;
}

function text(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(body);
}
