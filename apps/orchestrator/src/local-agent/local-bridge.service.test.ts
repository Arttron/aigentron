import { describe, expect, it, vi } from 'vitest';
import { LocalBridgeService, type BridgeSocket } from './local-bridge.service';
import type { LocalDevicesService } from './local-devices.service';
import type { LocalDevice } from './local-devices';
import { decodeFrame, encodeFrame } from './local-agent-proto';

const device = (id = 'd1'): LocalDevice => ({ id, hash: 'h', userId: 'u', label: 'Mac', createdAt: '', lastSeenAt: '' });

function fakeSocket() {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const sock: BridgeSocket = { send: (d) => void sent.push(d), close: (code, reason) => void closed.push({ code, reason }) };
  return { sock, sent, closed, frames: () => sent.map((s) => decodeFrame(s)!) };
}

function setup() {
  const touch = vi.fn();
  const bridge = new LocalBridgeService({ touch } as unknown as LocalDevicesService);
  return { bridge, touch };
}

const hello = (extra = {}) => encodeFrame({ type: 'hello', protoMin: 1, proto: 1, version: '0.1.129', os: 'darwin', arch: 'arm64', host: 'laptop', ...extra });

describe('LocalBridgeService', () => {
  it('welcomes a hello, notes the device and shows it online', () => {
    const { bridge, touch } = setup();
    const s = fakeSocket();
    const h = bridge.attach(s.sock, device());
    expect(bridge.isOnline('d1')).toBe(false);
    h.message(hello());
    expect(s.frames()[0]).toMatchObject({ type: 'welcome', proto: 1 });
    expect(bridge.isOnline('d1')).toBe(true);
    expect(bridge.connection('d1')).toMatchObject({ os: 'darwin', version: '0.1.129' });
    expect(touch).toHaveBeenCalledWith('d1', expect.objectContaining({ host: 'laptop' }), true);
    h.close();
    expect(bridge.isOnline('d1')).toBe(false);
  });

  it('refuses a protocol that does not meet and closes; the first frame must be a hello', () => {
    const { bridge } = setup();
    const a = fakeSocket();
    bridge.attach(a.sock, device('a')).message(hello({ protoMin: 5, proto: 6 }));
    expect(a.frames()[0]).toMatchObject({ type: 'refuse', code: 'proto_too_new' });
    expect(a.closed[0]?.code).toBe(4403);
    const b = fakeSocket();
    bridge.attach(b.sock, device('b')).message(encodeFrame({ type: 'ping', id: '1' }));
    expect(b.closed[0]?.code).toBe(4400);
    const c = fakeSocket();
    bridge.attach(c.sock, device('c')).message('garbage');
    expect(c.closed[0]?.code).toBe(4400);
  });

  it('answers a ping with a pong', () => {
    const { bridge } = setup();
    const s = fakeSocket();
    const h = bridge.attach(s.sock, device());
    h.message(hello());
    h.message(encodeFrame({ type: 'ping', id: 'p9' }));
    expect(s.frames()[1]).toEqual({ type: 'pong', id: 'p9' });
  });

  it('a command goes out and its result comes back; a stranger\'s result is ignored', async () => {
    const { bridge } = setup();
    const s = fakeSocket();
    const h = bridge.attach(s.sock, device());
    h.message(hello());
    const p = bridge.request('d1', 'status', { a: 1 });
    const cmd = s.frames()[1]!;
    expect(cmd).toMatchObject({ type: 'command', op: 'status', args: { a: 1 } });
    const other = fakeSocket();
    const ho = bridge.attach(other.sock, device('d2'));
    ho.message(hello());
    ho.message(encodeFrame({ type: 'result', id: cmd.id, ok: true, data: { stolen: true } })); // another device answering for d1
    h.message(encodeFrame({ type: 'result', id: cmd.id, ok: true, data: { v: 1 } }));
    await expect(p).resolves.toEqual({ ok: true, data: { v: 1 }, error: undefined });
  });

  it('an offline device, a timeout and a dropped line are {ok:false}, not exceptions', async () => {
    const { bridge } = setup();
    await expect(bridge.request('nobody', 'status')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('offline') });
    const s = fakeSocket();
    const h = bridge.attach(s.sock, device());
    h.message(hello());
    await expect(bridge.request('d1', 'status', {}, 20)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('in time') });
    const p = bridge.request('d1', 'status');
    h.close();
    await expect(p).resolves.toMatchObject({ ok: false, error: expect.stringContaining('disconnected') });
  });

  it('a newer connection replaces the older; revoke tells the device and closes', () => {
    const { bridge } = setup();
    const a = fakeSocket();
    bridge.attach(a.sock, device()).message(hello());
    const b = fakeSocket();
    bridge.attach(b.sock, device()).message(hello());
    expect(a.closed[0]?.code).toBe(4409);
    bridge.revoke('d1');
    expect(b.frames().at(-1)).toMatchObject({ type: 'refuse', code: 'revoked' });
    expect(b.closed.at(-1)?.code).toBe(4403);
    expect(bridge.isOnline('d1')).toBe(false);
  });
});

// ---- the real WebSocket path: HTTP server + gateway + a `ws` client ----
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { HttpAdapterHost } from '@nestjs/core';
import type { AccessService } from '../access/access.service';
import { LocalAgentGateway } from './local-agent.gateway';
import { newLocalDevice } from './local-devices';

describe('LocalAgentGateway (a real WebSocket)', () => {
  async function boot(allowed = true) {
    const server: Server = createServer((_q, r) => r.end('http'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { record, token } = newLocalDevice('u1', 'Mac');
    const devices = { verify: (t?: string) => (t === token ? record : null), touch: vi.fn() } as unknown as LocalDevicesService;
    const bridge = new LocalBridgeService(devices);
    const gw = new LocalAgentGateway({ httpAdapter: { getHttpServer: () => server } } as unknown as HttpAdapterHost, bridge, devices, { allowsRequest: () => allowed } as unknown as AccessService);
    gw.onApplicationBootstrap();
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-agent/ws`;
    return { server, bridge, gw, url, token, record, stop: () => { gw.onApplicationShutdown(); server.close(); } };
  }
  const open = (url: string, token?: string) =>
    new Promise<{ ws: WebSocket; status?: number }>((resolve) => {
      const ws = new WebSocket(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      ws.on('open', () => resolve({ ws }));
      ws.on('unexpected-response', (_q, res) => resolve({ ws, status: res.statusCode }));
      ws.on('error', () => undefined);
    });
  const next = (ws: WebSocket) => new Promise<string>((r) => ws.once('message', (d) => r(d.toString())));

  it('also serves a second listener (the built-in 80/443 server), once per server', async () => {
    const b = await boot();
    const other: Server = createServer((_q, r) => r.end('http'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    b.gw.attach(other);
    b.gw.attach(other); // a second call must not double the handler
    expect(other.listeners('upgrade')).toHaveLength(1);
    const { ws, status } = await open(`ws://127.0.0.1:${(other.address() as AddressInfo).port}/api/local-agent/ws`, b.token);
    expect(status).toBeUndefined();
    const welcome = next(ws);
    ws.send(hello());
    expect(decodeFrame(await welcome)).toMatchObject({ type: 'welcome' });
    ws.close();
    other.close();
    b.stop();
  });

  it('a paired device handshakes, is online, answers a command', async () => {
    const b = await boot();
    const { ws } = await open(b.url, b.token);
    const welcome = next(ws);
    ws.send(hello());
    expect(decodeFrame(await welcome)).toMatchObject({ type: 'welcome', proto: 1 });
    expect(b.bridge.isOnline(b.record.id)).toBe(true);
    const cmd = next(ws);
    const answer = b.bridge.request(b.record.id, 'status');
    const frame = decodeFrame(await cmd)!;
    ws.send(encodeFrame({ type: 'result', id: frame.id, ok: true, data: { fine: 1 } }));
    expect(await answer).toMatchObject({ ok: true, data: { fine: 1 } });
    const closed = new Promise<number>((r) => ws.once('close', (c) => r(c)));
    b.bridge.revoke(b.record.id);
    expect(await closed).toBe(4403);
    b.stop();
  });

  it('refuses an unknown token (401), a blocked address (421), and leaves other paths alone', async () => {
    const b = await boot();
    expect((await open(b.url, 'lag_0000000000000000_' + 'A'.repeat(43))).status).toBe(401);
    expect((await open(b.url)).status).toBe(401);
    b.stop();
    const c = await boot(false);
    expect((await open(c.url, c.token)).status).toBe(421);
    c.stop();
  });
});
