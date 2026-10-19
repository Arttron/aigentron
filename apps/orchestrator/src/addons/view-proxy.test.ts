/**
 * Integration test of the browser view proxy against a fake noVNC (HTTP + WebSocket echo) on ephemeral ports: who gets in,
 * what is relayed, what is stripped, and that the viewing cap and time limit hold. No Nest: the proxy is driven as the
 * controller and the server's `upgrade` event drive it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCookies } from '../auth/auth-core';
import { isViewPath, type Endpoint } from './addons-core';
import { ViewProxy, type ProxyDeps } from './view-proxy';

// ---- a tiny WebSocket codec (small payloads only — enough for a handshake, a ping and a close) ----
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (key: string) => createHash('sha1').update(key + GUID).digest('base64');

function readFrame(buf: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) throw new Error('frame too big for this test');
  if (buf.length < off + (masked ? 4 : 0) + len) return null;
  const mask = masked ? buf.subarray(off, off + 4) : null;
  off += masked ? 4 : 0;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < len; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
  return { opcode, payload, size: off + len };
}

function frame(opcode: number, payload: Buffer, mask?: Buffer): Buffer {
  const head = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | payload.length]);
  if (!mask) return Buffer.concat([head, payload]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, body]);
}

// ---- the fake add-on: a static page plus an echoing WebSocket at /websockify (as websockify + noVNC look to the proxy) ----
/** Upgraded sockets leave the server's own connection list; track every socket so teardown can really close the listener. */
function track(server: Server): () => Promise<void> {
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return () =>
    new Promise<void>((r) => {
      server.close(() => r());
      for (const s of sockets) s.destroy();
    });
}

async function fakeNoVnc(): Promise<{ server: Server; port: number; seen: IncomingMessage['headers'][]; stop: () => Promise<void> }> {
  const seen: IncomingMessage['headers'][] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url?.startsWith('/vnc.html')) {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'upstream=1', 'x-powered-by': 'fake', 'cache-control': 'public, max-age=60' });
      res.end('<html>noVNC</html>');
      return;
    }
    if (req.url === '/slow') return; // never answers
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  server.on('upgrade', (req, socket, head) => {
    seen.push(req.headers);
    if (!req.url?.startsWith('/websockify')) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(String(req.headers['sec-websocket-key']))}\r\n\r\n`);
    let buf: Buffer = head;
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const f = readFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.size);
        if (f.opcode === 8) {
          socket.end();
          return;
        }
        socket.write(frame(f.opcode, f.payload));
      }
    });
    socket.on('error', () => undefined);
    socket.on('end', () => socket.destroy());
  });
  const stop = track(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as { port: number }).port, seen, stop };
}

// ---- the dashboard side: the proxy on its own listener, with a stand-in for Socket.IO's "destroy unhandled upgrades" listener ----
const USERS: Record<string, { id: string; displayName: string; role: string }> = {
  op: { id: 'op', displayName: 'Olga', role: 'operator' },
  rev: { id: 'rev', displayName: 'Rita', role: 'reviewer' },
};
const TOKENS: Record<string, string> = { 'tok-op': 'op', 'tok-rev': 'rev', 'tok-gone': 'nobody' };

function deps(endpoint: Endpoint | null, over: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    auth: { isConfigured: () => true, sessionUserId: (h) => TOKENS[parseCookies(Array.isArray(h.cookie) ? h.cookie.join(';') : h.cookie).lds_session ?? ''] ?? null },
    users: {
      getRow: async (id) => {
        if (!USERS[id]) throw new Error('not found');
        return USERS[id]!;
      },
      defaultOperator: async () => USERS.op!,
    },
    access: { allowsRequest: () => true },
    cloudflare: { required: () => false, check: async () => ({ ok: false }) },
    endpoint: async () => endpoint,
    ...over,
  };
}

const quiet = { log: () => undefined, warn: () => undefined };

async function front(proxy: ViewProxy): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (isViewPath(req.url)) void proxy.handleHttp(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  // what engine.io does to upgrades it does not handle (so the dispatcher must keep ours away from it)
  server.on('upgrade', (_req, socket) => {
    setTimeout(() => {
      if (socket.writable && socket.bytesWritten <= 0) socket.end();
    }, 50);
  });
  proxy.attach(server);
  const stop = track(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, stop };
}

const VIEW = '/api/addons/browser/view';

function wsConnect(port: number, path: string, headers: Record<string, string> = {}): Promise<{ socket: Socket; status: number; head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const extra = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('');
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i === -1) return;
      socket.off('data', onData);
      const head = buf.subarray(0, i).toString();
      resolve({ socket, status: Number(head.split(' ')[1]), head, rest: buf.subarray(i + 4) });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

const nextData = (socket: Socket, initial = Buffer.alloc(0)): Promise<Buffer> =>
  initial.length ? Promise.resolve(initial) : new Promise((r) => socket.once('data', (d: Buffer) => r(d)));
const closed = (socket: Socket): Promise<void> => (socket.closed ? Promise.resolve() : new Promise((r) => socket.once('close', () => r())));
const drain = (socket: Socket, initial: Buffer): Promise<string> =>
  new Promise((r) => {
    const parts = [initial];
    socket.on('data', (d: Buffer) => parts.push(d));
    socket.once('close', () => r(Buffer.concat(parts).toString()));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('browser view proxy', () => {
  let up: Awaited<ReturnType<typeof fakeNoVnc>>;
  let endpoint: Endpoint;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    up = await fakeNoVnc();
    endpoint = { hostname: '127.0.0.1', port: up.port, basePath: '' };
  });
  afterAll(async () => {
    for (const stop of [...stops, up.stop]) await stop();
  });
  const start = async (proxy: ViewProxy) => {
    const f = await front(proxy);
    stops.push(f.stop);
    return f.port;
  };

  it('page: no session → 401, reviewer → 403, operator → the page with cookies/tokens stripped and framing restricted', async () => {
    const port = await start(new ViewProxy(deps(endpoint), { maxSessions: 3, sessionMs: 60_000, logger: quiet }));
    const url = `http://127.0.0.1:${port}${VIEW}/vnc.html?autoconnect=1`;
    const anon = await fetch(url);
    expect(anon.status).toBe(401);
    expect(await anon.text()).toBe('Sign in required.');
    const rev = await fetch(url, { headers: { cookie: 'lds_session=tok-rev' } });
    expect(rev.status).toBe(403);
    expect(await rev.text()).toMatch(/operator \| admin/);
    const gone = await fetch(url, { headers: { cookie: 'lds_session=tok-gone' } });
    expect(gone.status).toBe(403);

    up.seen.length = 0;
    const ok = await fetch(url, { headers: { cookie: 'lds_session=tok-op', authorization: 'Bearer secret', 'x-forwarded-for': '9.9.9.9', 'x-lds-user': 'op' }, redirect: 'manual' });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('<html>noVNC</html>');
    expect(ok.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(ok.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(ok.headers.get('cache-control')).toBe('private, max-age=60');
    expect(ok.headers.get('set-cookie')).toBeNull();
    expect(ok.headers.get('x-powered-by')).toBeNull();
    const seen = up.seen[0]!;
    expect(seen.cookie).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect(seen['x-forwarded-for']).toBeUndefined();
    expect(seen['x-lds-user']).toBeUndefined();
    expect(seen.host).toBe(`127.0.0.1:${up.port}`);

    const post = await fetch(url, { method: 'POST', headers: { cookie: 'lds_session=tok-op' } });
    expect(post.status).toBe(405);
    const missing = await fetch(`http://127.0.0.1:${port}${VIEW}/nothing.js`, { headers: { cookie: 'lds_session=tok-op' } });
    expect(missing.status).toBe(404);
  });

  it('page: domain allow-list and Cloudflare Access refusals apply here too', async () => {
    const port1 = await start(new ViewProxy(deps(endpoint, { access: { allowsRequest: () => false } }), { maxSessions: 3, sessionMs: 60_000, logger: quiet }));
    expect((await fetch(`http://127.0.0.1:${port1}${VIEW}/vnc.html`, { headers: { cookie: 'lds_session=tok-op' } })).status).toBe(403);
    const port2 = await start(new ViewProxy(deps(endpoint, { cloudflare: { required: () => true, check: async () => ({ ok: false }) } }), { maxSessions: 3, sessionMs: 60_000, logger: quiet }));
    const r = await fetch(`http://127.0.0.1:${port2}${VIEW}/vnc.html`, { headers: { cookie: 'lds_session=tok-op' } });
    expect(r.status).toBe(403);
    expect(await r.text()).toMatch(/Cloudflare Access/);
  });

  it('page: a path that climbs out is refused before anything is forwarded', async () => {
    const port = await start(new ViewProxy(deps(endpoint), { maxSessions: 3, sessionMs: 60_000, logger: quiet }));
    up.seen.length = 0;
    const r = await new Promise<string>((resolve) => {
      const s = connect(port, '127.0.0.1', () => s.write(`GET ${VIEW}/../../secrets HTTP/1.1\r\nHost: x\r\nCookie: lds_session=tok-op\r\nConnection: close\r\n\r\n`));
      const parts: Buffer[] = [];
      s.on('data', (d: Buffer) => parts.push(d));
      s.on('close', () => resolve(Buffer.concat(parts).toString()));
    });
    expect(r).toMatch(/^HTTP\/1\.1 400/);
    expect(up.seen).toHaveLength(0);
  });

  it('page: not enabled → 404; an add-on that does not answer → 502 with the logs hint', async () => {
    const port = await start(new ViewProxy(deps(null), { maxSessions: 3, sessionMs: 60_000, logger: quiet }));
    const r = await fetch(`http://127.0.0.1:${port}${VIEW}/vnc.html`, { headers: { cookie: 'lds_session=tok-op' } });
    expect(r.status).toBe(404);
    const dead = await start(new ViewProxy(deps({ hostname: '127.0.0.1', port: 1, basePath: '' }), { maxSessions: 3, sessionMs: 60_000, logger: quiet }));
    const d = await fetch(`http://127.0.0.1:${dead}${VIEW}/vnc.html`, { headers: { cookie: 'lds_session=tok-op' } });
    expect(d.status).toBe(502);
    expect(await d.text()).toMatch(/aigentron addon logs browser/);
    const slow = await start(new ViewProxy(deps(endpoint), { maxSessions: 3, sessionMs: 60_000, logger: quiet, upstreamTimeoutMs: 100 }));
    const s = await fetch(`http://127.0.0.1:${slow}${VIEW}/slow`, { headers: { cookie: 'lds_session=tok-op' } });
    expect(s.status).toBe(502);
  });

  it('socket: the same checks on the handshake, then an echo through the add-on; other upgrades still reach the previous listener', async () => {
    const lines: string[] = [];
    const proxy = new ViewProxy(deps(endpoint), { maxSessions: 3, sessionMs: 60_000, logger: { log: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) } });
    const port = await start(proxy);
    const anon = await wsConnect(port, `${VIEW}/websockify`);
    expect(anon.status).toBe(401);
    expect(await drain(anon.socket, anon.rest)).toBe('Sign in required.');
    const rev = await wsConnect(port, `${VIEW}/websockify`, { cookie: 'lds_session=tok-rev' });
    expect(rev.status).toBe(403);
    await closed(rev.socket);

    up.seen.length = 0;
    const ws = await wsConnect(port, `${VIEW}/websockify`, { cookie: 'lds_session=tok-op', authorization: 'Bearer secret', 'cf-connecting-ip': '203.0.113.7' });
    expect(ws.status).toBe(101);
    expect(ws.head).toMatch(/sec-websocket-accept/i);
    expect(up.seen[0]!.cookie).toBeUndefined();
    expect(up.seen[0]!.authorization).toBeUndefined();
    expect(up.seen[0]!['cf-connecting-ip']).toBeUndefined();
    expect(proxy.sessions.count).toBe(1);
    expect(lines.some((l) => /browser view opened by Olga \(operator\) from 203\.0\.113\.7 — 1\/3 watching/.test(l))).toBe(true);

    ws.socket.write(frame(1, Buffer.from('ping'), randomBytes(4)));
    const echo = readFrame(await nextData(ws.socket, ws.rest));
    expect(echo?.opcode).toBe(1);
    expect(echo?.payload.toString()).toBe('ping');

    ws.socket.write(frame(8, Buffer.from([0x03, 0xe8]), randomBytes(4)));
    await closed(ws.socket);
    await sleep(20);
    expect(proxy.sessions.count).toBe(0);
    expect(lines.some((l) => /browser view closed for Olga .* 0\/3 watching/.test(l))).toBe(true);

    // an upgrade for another path (Socket.IO's) is left to the listener that was there before
    const other = connect(port, '127.0.0.1', () => other.write(`GET /socket.io/?EIO=4 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
    const got = await new Promise<string>((r) => {
      const parts: Buffer[] = [];
      other.on('data', (d: Buffer) => parts.push(d));
      other.on('close', () => r(Buffer.concat(parts).toString()));
    });
    expect(got).toBe('');
    expect(up.seen).toHaveLength(1);
  });

  it('socket: not enabled → 404; the cap refuses the extra viewer with 503 and frees the slot when one leaves', async () => {
    const off = await start(new ViewProxy(deps(null), { maxSessions: 1, sessionMs: 60_000, logger: quiet }));
    const none = await wsConnect(off, `${VIEW}/websockify`, { cookie: 'lds_session=tok-op' });
    expect(none.status).toBe(404);
    await closed(none.socket);

    const proxy = new ViewProxy(deps(endpoint), { maxSessions: 1, sessionMs: 60_000, logger: quiet });
    const port = await start(proxy);
    const first = await wsConnect(port, `${VIEW}/websockify`, { cookie: 'lds_session=tok-op' });
    expect(first.status).toBe(101);
    const second = await wsConnect(port, `${VIEW}/websockify`, { cookie: 'lds_session=tok-op' });
    expect(second.status).toBe(503);
    expect(await drain(second.socket, second.rest)).toMatch(/at most 1 at once/);
    first.socket.destroy();
    await sleep(30);
    expect(proxy.sessions.count).toBe(0);
    const third = await wsConnect(port, `${VIEW}/websockify`, { cookie: 'lds_session=tok-op' });
    expect(third.status).toBe(101);
    third.socket.destroy();
    await sleep(10);
  });

  it('socket: the time limit ends the stream with a close frame that says why', async () => {
    const proxy = new ViewProxy(deps(endpoint), { maxSessions: 3, sessionMs: 250, logger: quiet });
    const port = await start(proxy);
    const ws = await wsConnect(port, `${VIEW}/websockify`, { cookie: 'lds_session=tok-op' });
    expect(ws.status).toBe(101);
    const data = await nextData(ws.socket, ws.rest);
    const f = readFrame(data);
    expect(f?.opcode).toBe(8);
    expect(f?.payload.readUInt16BE(0)).toBe(1000);
    expect(f?.payload.subarray(2).toString()).toBe('Session time is over');
    await closed(ws.socket);
    expect(proxy.sessions.count).toBe(0);
  });

  it('socket: an add-on that refuses the upgrade or is down → 502 and no session is kept', async () => {
    const proxy = new ViewProxy(deps(endpoint), { maxSessions: 3, sessionMs: 60_000, logger: quiet });
    const port = await start(proxy);
    const r = await wsConnect(port, `${VIEW}/not-a-socket`, { cookie: 'lds_session=tok-op' });
    expect(r.status).toBe(502);
    expect(await drain(r.socket, r.rest)).toMatch(/HTTP 404/);
    expect(proxy.sessions.count).toBe(0);
    const down = await start(new ViewProxy(deps({ hostname: '127.0.0.1', port: 1, basePath: '' }), { maxSessions: 3, sessionMs: 60_000, logger: quiet }));
    const d = await wsConnect(down, `${VIEW}/websockify`, { cookie: 'lds_session=tok-op' });
    expect(d.status).toBe(502);
    await closed(d.socket);
  });

  it('with sign-in off, the acting user (or the default operator) is used, as the API does', async () => {
    const open = deps(endpoint, { auth: { isConfigured: () => false, sessionUserId: () => null } });
    const port = await start(new ViewProxy(open, { maxSessions: 3, sessionMs: 60_000, logger: quiet }));
    expect((await fetch(`http://127.0.0.1:${port}${VIEW}/vnc.html`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}${VIEW}/vnc.html`, { headers: { 'x-lds-user': 'rev' } })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}${VIEW}/vnc.html`, { headers: { 'x-lds-user': 'ghost' } })).status).toBe(403);
  });
});
