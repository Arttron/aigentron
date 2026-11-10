import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import type { ProxyItem } from './proxy-store';

/**
 * The browser gateway: a small forward proxy (HTTP requests and CONNECT tunnels) that the Playwright browser always points at. Which upstream proxy it forwards
 * to — or none, a direct connection — is read per connection from the saved proxies, so the choice changes without restarting the browser; the upstream's
 * login never leaves the server. Pure Node (`http`, `net`, `tls`): `gateway.test.ts` runs it against a fake upstream proxy.
 */

/** Addresses the gateway never connects to itself: the machine's own and private networks (a page must not reach them THROUGH the gateway — the browser goes to those directly). */
export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateIp(mapped[1]!);
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(v)) return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v);
  return false;
}

export function splitHostPort(target: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(target.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (port < 1 || port > 65535) return null;
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port };
}

export const basicAuthHeader = (u?: string, p?: string): string | null => (u ? `Basic ${Buffer.from(`${u}:${p ?? ''}`).toString('base64')}` : null);

type Lookup = (host: string) => Promise<string[]>;

export interface GatewayOptions {
  /** the proxy to forward through now, or null for a direct connection */
  upstream: () => Pick<ProxyItem, 'server' | 'username' | 'password'> | null;
  /** may this client use the gateway (default: loopback and private addresses only) */
  clientAllowed?: (remote: string | undefined) => boolean;
  /** name → addresses (default: the system resolver) */
  lookup?: Lookup;
  /** direct connections to private addresses (tests only) */
  allowPrivate?: boolean;
  connectTimeoutMs?: number;
  log?: (msg: string) => void;
}

const defaultLookup: Lookup = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The upstream's address parts. */
function upstreamEndpoint(server: string): { host: string; port: number; tls: boolean } {
  const u = new URL(server);
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), tls: u.protocol === 'https:' };
}

/** A tunnel to host:port through an HTTP(S) upstream proxy: resolves with the socket once the proxy has said 200 (and any bytes that came with it). */
export function tunnelThrough(up: Pick<ProxyItem, 'server' | 'username' | 'password'>, host: string, port: number, timeoutMs = 15_000): Promise<{ socket: net.Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    if (up.server.startsWith('socks')) return reject(new GatewayError(502, 'the gateway does not speak SOCKS: use an HTTP port of the proxy'));
    const ep = upstreamEndpoint(up.server);
    const socket: net.Socket = ep.tls ? tls.connect({ host: ep.host, port: ep.port, servername: ep.host }) : net.connect({ host: ep.host, port: ep.port });
    const fail = (e: Error) => {
      socket.destroy();
      reject(e instanceof GatewayError ? e : new GatewayError(502, `the proxy could not be reached (${(e as NodeJS.ErrnoException).code ?? e.message})`));
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('timed out')));
    socket.once('error', fail);
    socket.once(ep.tls ? 'secureConnect' : 'connect', () => {
      const auth = basicAuthHeader(up.username, up.password);
      const target = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}Proxy-Connection: keep-alive\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buf.length > 16_384) fail(new Error('the proxy answered with too much'));
          return;
        }
        socket.off('data', onData);
        socket.setTimeout(0);
        socket.off('error', fail);
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1] ?? 0);
        if (status === 200) return resolve({ socket, rest: buf.subarray(end + 4) });
        socket.destroy();
        reject(new GatewayError(status === 407 ? 502 : 502, status === 407 ? 'the proxy refused the login (407)' : `the proxy answered ${status || 'something unreadable'}`));
      };
      socket.on('data', onData);
    });
  });
}

export type Gateway = http.Server & {
  /** drop every open connection (the browser reconnects through whatever is chosen now): called when the choice changes, because a kept-alive tunnel would go on through the old proxy */
  flush(): void;
};

export function createGateway(opts: GatewayOptions): Gateway {
  const lookup = opts.lookup ?? defaultLookup;
  const allowed =
    opts.clientAllowed ??
    ((remote?: string) => {
      const a = (remote ?? '').replace(/^::ffff:/, '');
      return a === '' ? false : isPrivateIp(a);
    });
  const log = opts.log ?? (() => undefined);

  /** A direct connection, resolving the name ourselves: a name that points at a private address is refused. */
  const direct = async (host: string, port: number): Promise<net.Socket> => {
    const addrs = net.isIP(host) ? [host] : await lookup(host);
    if (!addrs.length) throw new GatewayError(502, `cannot resolve ${host}`);
    if (!opts.allowPrivate && addrs.some(isPrivateIp)) throw new GatewayError(403, 'the gateway does not connect to private or local addresses (the browser reaches those itself)');
    return await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: addrs[0]!, port });
      s.setTimeout(opts.connectTimeoutMs ?? 15_000, () => {
        s.destroy();
        reject(new GatewayError(504, 'timed out'));
      });
      s.once('error', (e) => reject(new GatewayError(502, `cannot connect (${(e as NodeJS.ErrnoException).code ?? e.message})`)));
      s.once('connect', () => {
        s.setTimeout(0);
        s.removeAllListeners('error');
        resolve(s);
      });
    });
  };

  const server = http.createServer() as Gateway;
  const open = new Set<net.Socket>();
  server.on('connection', (s: net.Socket) => {
    open.add(s);
    s.on('close', () => open.delete(s));
  });
  server.flush = () => {
    for (const s of open) s.destroy();
    open.clear();
  };

  // HTTPS (and any other tunnelled traffic): CONNECT host:port
  server.on('connect', (req, client: net.Socket, head: Buffer) => {
    client.on('error', () => undefined);
    void (async () => {
      try {
        if (!allowed(client.remoteAddress)) throw new GatewayError(403, 'this address may not use the gateway');
        const t = splitHostPort(req.url ?? '', 443);
        if (!t) throw new GatewayError(400, 'bad CONNECT target');
        const up = opts.upstream();
        let remote: net.Socket;
        let rest: Buffer = Buffer.alloc(0);
        if (up) ({ socket: remote, rest } = await tunnelThrough(up, t.host, t.port, opts.connectTimeoutMs));
        else remote = await direct(t.host, t.port);
        remote.on('error', () => client.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) client.write(rest);
        if (head.length) remote.write(head);
        remote.pipe(client);
        client.pipe(remote);
        client.on('close', () => remote.destroy());
        remote.on('close', () => client.destroy());
      } catch (e) {
        const g = e instanceof GatewayError ? e : new GatewayError(502, (e as Error).message);
        log(`CONNECT ${req.url}: ${g.message}`);
        client.end(`HTTP/1.1 ${g.status} ${g.status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${g.message}\n`);
      }
    })();
  });

  // plain HTTP: the request line carries the whole address
  server.on('request', (req, res) => {
    const fail = (status: number, message: string) => {
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end(`${message}\n`);
    };
    if (!allowed(req.socket.remoteAddress)) return fail(403, 'this address may not use the gateway');
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      return fail(404, 'This is a proxy for the browser: send it requests with a full address.');
    }
    if (url.protocol !== 'http:') return fail(400, 'only http:// requests are forwarded this way (https goes through CONNECT)');
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const up = opts.upstream();
    const forward = (options: http.RequestOptions, useTls = false) => {
      const out = (useTls ? https : http).request(options, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      out.setTimeout(opts.connectTimeoutMs ?? 30_000, () => out.destroy(new Error('timed out')));
      out.on('error', (e) => {
        log(`${req.method} ${url.host}: ${e.message}`);
        fail(e instanceof GatewayError ? e.status : 502, e.message);
      });
      req.pipe(out);
    };
    if (up) {
      if (up.server.startsWith('socks')) return fail(502, 'the gateway does not speak SOCKS: use an HTTP port of the proxy');
      const ep = upstreamEndpoint(up.server);
      const auth = basicAuthHeader(up.username, up.password);
      forward({ host: ep.host, port: ep.port, method: req.method, path: url.href, headers: { ...headers, ...(auth ? { 'proxy-authorization': auth } : {}) } }, ep.tls);
      return;
    }
    // direct: the name is resolved here and checked (a name that points at a private address is refused)
    void (async () => {
      try {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addrs = net.isIP(host) ? [host] : await lookup(host);
        if (!addrs.length) throw new GatewayError(502, `cannot resolve ${host}`);
        if (!opts.allowPrivate && addrs.some(isPrivateIp)) throw new GatewayError(403, 'the gateway does not connect to private or local addresses (the browser reaches those itself)');
        forward({ host: addrs[0], port: Number(url.port || 80), method: req.method, path: url.pathname + url.search, headers });
      } catch (e) {
        fail(e instanceof GatewayError ? e.status : 502, (e as Error).message);
      }
    })();
  });

  server.on('clientError', (_e, socket) => socket.destroy());
  return server;
}

/** One plain-HTTP GET through a proxy (to try it: what address do sites see?). */
export function fetchThrough(up: Pick<ProxyItem, 'server' | 'username' | 'password'>, url: string, timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (up.server.startsWith('socks')) return reject(new Error('SOCKS proxies are not supported'));
    const ep = upstreamEndpoint(up.server);
    const auth = basicAuthHeader(up.username, up.password);
    const req = (ep.tls ? https : http).request({ host: ep.host, port: ep.port, method: 'GET', path: url, headers: { Host: new URL(url).host, ...(auth ? { 'Proxy-Authorization': auth } : {}) }, timeout: timeoutMs }, (r) => {
      if (r.statusCode === 407) {
        r.resume();
        return reject(new Error('the proxy refused the login (407)'));
      }
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.length < 64 && chunks.push(c));
      r.on('end', () => (r.statusCode && r.statusCode < 400 ? resolve(Buffer.concat(chunks).toString('utf8').trim().slice(0, 200)) : reject(new Error(`the proxy answered ${r.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => reject(new Error((e as NodeJS.ErrnoException).code ? `cannot connect (${(e as NodeJS.ErrnoException).code})` : e.message)));
    req.end();
  });
}
