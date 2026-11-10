import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { ProxyGatewayService } from './proxy-gateway.service';

const dirs: string[] = [];
const make = () => {
  const d = mkdtempSync(join(tmpdir(), 'proxy-svc-'));
  dirs.push(d);
  return new ProxyGatewayService({ secretsDir: d, proxyGatewayPort: 0, proxyGatewayBind: '127.0.0.1' } as AppConfigService);
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('what an agent can do with the browser proxy', () => {
  it('lists the saved proxies by name and host — never a login — and which one is in use', () => {
    const s = make();
    expect(s.agentList()).toMatch(/No proxies are saved/);
    s.store.add('lt-1', 'res.proxy-seller.com;10000;user;SECRETpw');
    s.store.add('de-1', 'de.example.com:3128');
    const t = s.agentList();
    expect(t).toContain('lt-1 — res.proxy-seller.com:10000');
    expect(t).toContain('de-1');
    expect(t).toContain('direct');
    expect(t).not.toContain('SECRETpw');
    expect(t).not.toContain('user');
  });

  it('chooses a proxy by name (any case) or direct, and the dashboard sees who did it', () => {
    const s = make();
    const lt = s.store.add('lt-1', 'h.example;80;u;p');
    expect(s.agentUse('LT-1', 'task9')).toMatch(/goes through "lt-1"/);
    expect(s.store.active()?.id).toBe(lt.id);
    expect(s.list().activeBy?.by).toBe('agent (task task9)');
    expect(s.agentList()).toContain('← in use');
    expect(s.agentUse('direct', 'task9')).toMatch(/directly/);
    expect(s.store.active()).toBeNull();
  });

  it('refuses an unknown name (listing the names) and everything when the operator switched it off', () => {
    const s = make();
    s.store.add('lt-1', 'h.example:80');
    expect(() => s.agentUse('xx', 't')).toThrow(/no saved proxy named "xx".*lt-1/);
    expect(() => s.agentUse('  ', 't')).toThrow(/give the name/);
    s.store.setAgentsCanSwitch(false);
    expect(() => s.agentUse('lt-1', 't')).toThrow(/did not allow/);
    expect(s.agentList()).toMatch(/did not allow agents/);
  });
});
