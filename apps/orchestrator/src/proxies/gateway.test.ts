import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { basicAuthHeader, createGateway, fetchThrough, isPrivateIp, splitHostPort } from './gateway';

const servers: (http.Server | net.Server)[] = [];
const listen = async <T extends http.Server | net.Server>(s: T): Promise<T & { port: number }> => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return Object.assign(s, { port: (s.address() as AddressInfo).port });
};
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A target web server: answers "target:<path>". */
const target = () => listen(http.createServer((req, res) => res.end(`target:${req.url}`)));

/** A fake upstream proxy that wants a login (user / pass); remembers what it was asked. */
const fakeUpstream = async () => {
  const seen: { auth?: string; url?: string; connect?: string }[] = [];
  const ok = (h: string | undefined) => h === basicAuthHeader('user', 'pass');
  const server = http.createServer((req, res) => {
    seen.push({ auth: req.headers['proxy-authorization'] as string | undefined, url: req.url });
    if (!ok(req.headers['proxy-authorization'] as string | undefined)) {
      res.writeHead(407);
      return res.end();
    }
    res.end(`upstream saw ${req.url}`);
  });
  server.on('connect', (req, client: net.Socket, head: Buffer) => {
    seen.push({ auth: req.headers['proxy-authorization'] as string | undefined, connect: req.url });
    client.on('error', () => undefined);
    if (!ok(req.headers['proxy-authorization'] as string | undefined)) return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    const [h, p] = (req.url ?? '').split(':');
    const out = net.connect(Number(p), h, () => {
      client.write('HTTP/1.1 200 OK\r\n\r\n');
      if (head.length) out.write(head);
      out.pipe(client);
      client.pipe(out);
    });
    out.on('error', () => client.destroy());
  });
  return Object.assign(await listen(server), { seen });
};

/** An HTTP request to a proxy, with the whole address in the request line. */
const viaProxy = (proxyPort: number, url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { Host: new URL(url).host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body.trim() }));
    });
    r.on('error', reject);
    r.end();
  });

/** CONNECT host:port through a proxy, then speak HTTP/1.0 through the tunnel. */
const tunnel = (proxyPort: number, host: string, port: number) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    let buf = '';
    let opened = false;
    s.on('data', (c) => {
      buf += c.toString('latin1');
      if (!opened && buf.includes('\r\n\r\n')) {
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf)?.[1]);
        if (status !== 200) return resolve({ status, body: buf.split('\r\n\r\n')[1]!.trim() });
        opened = true;
        buf = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        s.write(`GET /hello HTTP/1.0\r\nHost: ${host}\r\n\r\n`);
      }
    });
    s.on('end', () => resolve({ status: 200, body: buf.split('\r\n\r\n').pop()!.trim() }));
    s.on('error', reject);
  });

describe('helpers', () => {
  it('isPrivateIp: local and private networks, v4 and v6; public addresses are not', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateIp(a), a).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2001:4860:4860::8888']) expect(isPrivateIp(a), a).toBe(false);
  });
  it('splitHostPort', () => {
    expect(splitHostPort('example.com:443', 80)).toEqual({ host: 'example.com', port: 443 });
    expect(splitHostPort('example.com', 80)).toEqual({ host: 'example.com', port: 80 });
    expect(splitHostPort('[::1]:8080', 80)).toEqual({ host: '::1', port: 8080 });
    expect(splitHostPort('x:99999', 80)).toBeNull();
  });
});

describe('the browser gateway', () => {
  it('direct: forwards a plain HTTP request and tunnels CONNECT', async () => {
    const t = await target();
    const gw = await listen(createGateway({ upstream: () => null, allowPrivate: true }));
    expect(await viaProxy(gw.port, `http://127.0.0.1:${t.port}/a?b=1`)).toEqual({ status: 200, body: 'target:/a?b=1' });
    const r = await tunnel(gw.port, '127.0.0.1', t.port);
    expect(r).toEqual({ status: 200, body: 'target:/hello' });
  });

  it('through an upstream proxy: the login is added by the gateway (the browser never has it), for requests and for tunnels', async () => {
    const t = await target();
    const up = await fakeUpstream();
    const gw = await listen(createGateway({ upstream: () => ({ server: `http://127.0.0.1:${up.port}`, username: 'user', password: 'pass' }), allowPrivate: true }));
    const a = await viaProxy(gw.port, `http://example.test/page`);
    expect(a).toEqual({ status: 200, body: 'upstream saw http://example.test/page' });
    expect(up.seen[0]!.auth).toBe(basicAuthHeader('user', 'pass'));
    const b = await tunnel(gw.port, '127.0.0.1', t.port);
    expect(b).toEqual({ status: 200, body: 'target:/hello' });
    expect(up.seen.at(-1)).toMatchObject({ connect: `127.0.0.1:${t.port}`, auth: basicAuthHeader('user', 'pass') });
  });

  it('a wrong login is a readable 502, not a hang', async () => {
    const up = await fakeUpstream();
    const gw = await listen(createGateway({ upstream: () => ({ server: `http://127.0.0.1:${up.port}`, username: 'user', password: 'WRONG' }), allowPrivate: true }));
    const r = await tunnel(gw.port, '127.0.0.1', 9);
    expect(r.status).toBe(502);
    expect(r.body).toMatch(/refused the login \(407\)/);
    expect(r.body).not.toContain('WRONG');
  });

  it('the choice changes on the fly: direct, then through the proxy, then direct again — no restart', async () => {
    const t = await target();
    const up = await fakeUpstream();
    let active: { server: string; username: string; password: string } | null = null;
    const gw = await listen(createGateway({ upstream: () => active, allowPrivate: true }));
    expect((await viaProxy(gw.port, `http://127.0.0.1:${t.port}/x`)).body).toBe('target:/x');
    active = { server: `http://127.0.0.1:${up.port}`, username: 'user', password: 'pass' };
    expect((await viaProxy(gw.port, `http://127.0.0.1:${t.port}/x`)).body).toContain('upstream saw');
    active = null;
    expect((await viaProxy(gw.port, `http://127.0.0.1:${t.port}/x`)).body).toBe('target:/x');
  });

  it('direct mode never connects to a private address (not by number, not by a name that resolves to one)', async () => {
    const t = await target();
    const gw = await listen(createGateway({ upstream: () => null, lookup: async (h) => (h === 'sneaky.example' ? ['127.0.0.1'] : ['93.184.216.34']) }));
    expect((await tunnel(gw.port, '127.0.0.1', t.port)).status).toBe(403);
    expect((await tunnel(gw.port, 'sneaky.example', t.port)).status).toBe(403);
    expect((await viaProxy(gw.port, `http://127.0.0.1:${t.port}/x`)).status).toBe(403);
    expect((await viaProxy(gw.port, `http://sneaky.example:${t.port}/x`)).status).toBe(403);
  });

  it('only local / private clients may use it', async () => {
    const t = await target();
    const gw = await listen(createGateway({ upstream: () => null, allowPrivate: true, clientAllowed: () => false }));
    expect((await viaProxy(gw.port, `http://127.0.0.1:${t.port}/x`)).status).toBe(403);
    expect((await tunnel(gw.port, '127.0.0.1', t.port)).status).toBe(403);
  });

  it('a request that is not for a proxy gets a plain answer; a SOCKS upstream is refused with the reason', async () => {
    const gw = await listen(createGateway({ upstream: () => null }));
    const r = await new Promise<{ status: number; body: string }>((resolve, reject) =>
      http.get({ host: '127.0.0.1', port: gw.port, path: '/' }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b.trim() }));
      }).on('error', reject),
    );
    expect(r.status).toBe(404);
    const gw2 = await listen(createGateway({ upstream: () => ({ server: 'socks5://127.0.0.1:1', username: 'u', password: 'p' }) }));
    const s = await viaProxy(gw2.port, 'http://example.test/');
    expect(s.status).toBe(502);
    expect(s.body).toMatch(/SOCKS/);
  });
});

describe('fetchThrough (the Test button)', () => {
  it('asks a page through the proxy with its login, and reports a refused login', async () => {
    const up = await fakeUpstream();
    expect(await fetchThrough({ server: `http://127.0.0.1:${up.port}`, username: 'user', password: 'pass' }, 'http://api.ipify.org/')).toBe('upstream saw http://api.ipify.org/');
    await expect(fetchThrough({ server: `http://127.0.0.1:${up.port}`, username: 'user', password: 'bad' }, 'http://api.ipify.org/')).rejects.toThrow(/407/);
  });
});

describe('flush', () => {
  it('closes the open connections, so a kept-alive tunnel does not go on through the old choice', async () => {
    const t = await target();
    const gw = await listen(createGateway({ upstream: () => null, allowPrivate: true }));
    const s = net.connect(gw.port, '127.0.0.1');
    await new Promise<void>((r) => s.once('connect', () => r()));
    s.write(`CONNECT 127.0.0.1:${t.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise<void>((r) => s.once('data', () => r()));
    const closed = new Promise<void>((r) => s.once('close', () => r()));
    gw.flush();
    await closed;
    expect(s.destroyed).toBe(true);
  });
});
