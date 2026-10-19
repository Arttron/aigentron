import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  ViewSessions,
  addonCommands,
  addonStatus,
  endpointHostAllowed,
  formatDuration,
  forwardRequestHeaders,
  isViewPath,
  parseDescriptor,
  parseEndpoint,
  parseState,
  rawHttpAnswer,
  responseHeaders,
  upgradeResponseHeaders,
  upstreamPath,
  wsCloseFrame,
} from './addons-core';
import { ROLES_KEY } from '../identity/roles.decorator';
import { AddonsController } from './addons.controller';

const descriptor = { name: 'browser', title: 'Browser', description: 'A browser.', requires: { ramMb: 1536, diskMb: 1500 }, ports: { view: 6080, cdp: 9222 }, backends: ['bare', 'docker'] };
const state = {
  name: 'browser',
  enabled: true,
  backend: 'bare',
  version: '1.0.0',
  installedAt: '2026-10-19T10:00:00Z',
  browser: 'chromium 131',
  arch: 'x86_64',
  endpoints: { view: 'http://127.0.0.1:6080', cdp: 'http://127.0.0.1:9222' },
  profiles: ['agent'],
  notes: ['hello'],
};

describe('parseDescriptor', () => {
  it('accepts the contract shape', () => {
    const r = parseDescriptor(descriptor);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(descriptor);
  });
  it('refuses bad names, ports and backends', () => {
    expect(parseDescriptor({ ...descriptor, name: 'Bad Name' }).ok).toBe(false);
    expect(parseDescriptor({ ...descriptor, ports: { view: 0, cdp: 9222 } }).ok).toBe(false);
    expect(parseDescriptor({ ...descriptor, ports: { view: 6080, cdp: 70000 } }).ok).toBe(false);
    expect(parseDescriptor({ ...descriptor, backends: ['vm'] }).ok).toBe(false);
    expect(parseDescriptor({ ...descriptor, title: '' }).ok).toBe(false);
    expect(parseDescriptor('nope').ok).toBe(false);
    expect(parseDescriptor(null).ok).toBe(false);
  });
  it('drops unknown backends and negative requirements', () => {
    const r = parseDescriptor({ ...descriptor, backends: ['docker', 'vm', 'docker'], requires: { ramMb: -5, diskMb: 'x' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.backends).toEqual(['docker']);
      expect(r.value.requires).toEqual({ ramMb: 0, diskMb: 0 });
    }
  });
});

describe('endpoint whitelist', () => {
  it('allows loopback, the docker host, single-label docker names and private addresses', () => {
    for (const h of ['127.0.0.1', '127.0.0.5', 'localhost', '::1', 'host.docker.internal', 'aigentron-browser', 'browser', '10.0.0.5', '172.18.0.3', '192.168.1.9']) {
      expect(endpointHostAllowed(h), h).toBe(true);
    }
  });
  it('refuses public names and addresses', () => {
    for (const h of ['example.com', 'evil.example.com', '8.8.8.8', '172.32.0.1', '1.1.1.1', '', '2606:4700::1', 'a.b']) {
      expect(endpointHostAllowed(h), h).toBe(false);
    }
  });
  it('parses an endpoint URL and refuses everything that is not a plain internal http URL', () => {
    expect(parseEndpoint('http://127.0.0.1:6080')).toEqual({ ok: true, value: { hostname: '127.0.0.1', port: 6080, basePath: '' } });
    expect(parseEndpoint('http://browser:6080/novnc/')).toEqual({ ok: true, value: { hostname: 'browser', port: 6080, basePath: '/novnc' } });
    expect(parseEndpoint('http://[::1]:6080')).toEqual({ ok: true, value: { hostname: '::1', port: 6080, basePath: '' } });
    expect(parseEndpoint('http://127.0.0.1')).toEqual({ ok: true, value: { hostname: '127.0.0.1', port: 80, basePath: '' } });
    expect(parseEndpoint('https://127.0.0.1:6080').ok).toBe(false);
    expect(parseEndpoint('http://example.com:6080').ok).toBe(false);
    expect(parseEndpoint('http://user:pw@127.0.0.1:6080').ok).toBe(false);
    expect(parseEndpoint('http://127.0.0.1:6080/?x=1').ok).toBe(false);
    expect(parseEndpoint('http://127.0.0.1:6080/a/../b')).toEqual({ ok: true, value: { hostname: '127.0.0.1', port: 6080, basePath: '/b' } }); // the URL parser normalises it
    expect(parseEndpoint('not a url').ok).toBe(false);
    expect(parseEndpoint(6080).ok).toBe(false);
  });
});

describe('parseState', () => {
  it('accepts the contract shape', () => {
    const r = parseState(state, 'browser');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(state);
  });
  it('refuses a state whose name does not match the folder, or whose endpoint is not internal', () => {
    expect(parseState(state, 'other').ok).toBe(false);
    expect(parseState({ ...state, endpoints: { view: 'http://example.com:6080', cdp: null } }).ok).toBe(false);
    expect(parseState({ ...state, endpoints: { view: 'http://127.0.0.1:6080', cdp: 'http://1.2.3.4:9222' } }).ok).toBe(false);
    expect(parseState({ ...state, enabled: 'yes' }).ok).toBe(false);
    expect(parseState({ ...state, backend: 'vm' }).ok).toBe(false);
  });
  it('tolerates missing optional fields and trims lists', () => {
    const r = parseState({ name: 'browser', enabled: false, backend: 'docker', notes: Array(40).fill('n'), profiles: [1, 'agent'] }, 'browser');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.endpoints).toEqual({ view: null, cdp: null });
      expect(r.value.notes).toHaveLength(20);
      expect(r.value.profiles).toEqual(['agent']);
      expect(r.value.version).toBe('');
    }
  });
});

describe('status and commands', () => {
  it('derives the status', () => {
    const s = parseState(state, 'browser');
    const st = s.ok ? s.value : null;
    expect(addonStatus(null, null)).toBe('not-installed');
    expect(addonStatus(st, true)).toBe('enabled-healthy');
    expect(addonStatus(st, false)).toBe('enabled-unreachable');
    expect(addonStatus(st && { ...st, enabled: false }, null)).toBe('disabled');
  });
  it('shows the exact server commands', () => {
    expect(addonCommands('browser')).toEqual({
      enable: 'sudo aigentron addon enable browser',
      enableDocker: 'sudo aigentron addon enable browser --backend docker',
      disable: 'sudo aigentron addon disable browser',
      logs: 'aigentron addon logs browser',
    });
  });
});

describe('view proxy helpers', () => {
  it('matches only the view path', () => {
    expect(isViewPath('/api/addons/browser/view')).toBe(true);
    expect(isViewPath('/api/addons/browser/view/vnc.html?x=1')).toBe(true);
    expect(isViewPath('/api/addons/browser/viewer')).toBe(false);
    expect(isViewPath('/api/addons')).toBe(false);
    expect(isViewPath('/socket.io/?EIO=4')).toBe(false);
    expect(isViewPath(undefined)).toBe(false);
  });
  it('maps the dashboard path to the upstream path and refuses climbing out', () => {
    expect(upstreamPath('/api/addons/browser/view/app/ui.js?v=1')).toBe('/app/ui.js?v=1');
    expect(upstreamPath('/api/addons/browser/view')).toBe('/');
    expect(upstreamPath('/api/addons/browser/view/')).toBe('/');
    expect(upstreamPath('/api/addons/browser/view/../../etc')).toBeNull();
    expect(upstreamPath('/api/addons/browser/view/%2e%2e/x')).toBeNull();
    expect(upstreamPath('/api/addons/browser/view/a\\b')).toBeNull();
    expect(upstreamPath('/other')).toBeNull();
  });
  it('forwards only what a static server needs — never cookies, tokens or forwarding headers', () => {
    const h = forwardRequestHeaders(
      { cookie: 'lds_session=x', authorization: 'Bearer y', 'x-lds-user': 'u', 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '1.2.3.4', host: 'dev.example.com', accept: 'text/html', 'user-agent': 'UA', 'if-none-match': '"e"', 'sec-websocket-key': 'k' },
      '127.0.0.1:6080',
    );
    expect(h).toEqual({ host: '127.0.0.1:6080', accept: 'text/html', 'user-agent': 'UA', 'if-none-match': '"e"' });
    const ws = forwardRequestHeaders({ upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'k', 'sec-websocket-version': '13', cookie: 'a=b', origin: 'https://dev.example.com' }, 'h', true);
    expect(ws).toEqual({ host: 'h', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'k', 'sec-websocket-version': '13' });
  });
  it('relays file headers and adds the framing restrictions', () => {
    const h = responseHeaders({ 'content-type': 'text/html', 'set-cookie': ['a=b'], 'x-powered-by': 'x', 'cache-control': 'public, max-age=60', etag: '"e"' });
    expect(h['set-cookie']).toBeUndefined();
    expect(h['x-powered-by']).toBeUndefined();
    expect(h).toMatchObject({ 'content-type': 'text/html', etag: '"e"', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'self'", 'cache-control': 'private, max-age=60' });
    expect(responseHeaders({})['cache-control']).toBe('private, max-age=600');
    expect(upgradeResponseHeaders({ upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-accept': 'acc', 'set-cookie': 'x' })).toEqual({ upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-accept': 'acc' });
  });
  it('builds a close frame and a raw refusal', () => {
    const f = wsCloseFrame(1000, 'bye');
    expect([...f]).toEqual([0x88, 5, 0x03, 0xe8, 0x62, 0x79, 0x65]);
    expect(wsCloseFrame(1000, 'x'.repeat(200)).length).toBe(4 + 123);
    expect(rawHttpAnswer(401, 'Sign in required.')).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n[\s\S]*\r\n\r\nSign in required\.$/);
  });
  it('limits concurrent sessions and tells how long one has left', () => {
    const s = new ViewSessions(2, 1000);
    const a = s.open({ userId: 'u', userName: 'U', role: 'operator', from: '::1' }, 0)!;
    const b = s.open({ userId: 'u', userName: 'U', role: 'operator', from: '::1' }, 0)!;
    expect(a.id).not.toBe(b.id);
    expect(s.open({ userId: 'u', userName: 'U', role: 'operator', from: '::1' }, 0)).toBeNull();
    expect(s.count).toBe(2);
    expect(s.remaining(a, 400)).toBe(600);
    expect(s.remaining(a, 5000)).toBe(0);
    expect(s.close(a.id)?.id).toBe(a.id);
    expect(s.close(a.id)).toBeNull();
    expect(s.open({ userId: 'u', userName: 'U', role: 'operator', from: '::1' }, 0)).not.toBeNull();
  });
  it('formats durations for the audit line', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });
});

describe('AddonsController', () => {
  it('guards the browser view with the operator/admin role (the list stays readable by any signed-in person)', () => {
    const view = AddonsController.prototype.browserView as unknown as object;
    expect(Reflect.getMetadata(ROLES_KEY, view)).toEqual(['operator', 'admin']);
    expect(Reflect.getMetadata(ROLES_KEY, AddonsController.prototype.list as unknown as object)).toBeUndefined();
  });
});
