import { describe, expect, it } from 'vitest';
import { hostAllowed, requestAllowed, isAlwaysAllowed, normalizeHost, parseDomainEntry, parseDomainList } from './access-core';

describe('normalizeHost', () => {
  it('strips ports, brackets and trailing dots', () => {
    expect(normalizeHost('Dev.Example.com:3011')).toBe('dev.example.com');
    expect(normalizeHost('[::1]:3001')).toBe('::1');
    expect(normalizeHost('localhost')).toBe('localhost');
    expect(normalizeHost('example.com.')).toBe('example.com');
    expect(normalizeHost(undefined)).toBe('');
  });
});

describe('isAlwaysAllowed (port forwarding must keep working)', () => {
  it.each(['localhost', '127.0.0.1', '::1', '192.168.1.20', '10.0.0.5', '203.0.113.7', 'orchestrator', 'myserver', 'app.localhost'])('accepts %s', (h) => {
    expect(isAlwaysAllowed(h)).toBe(true);
  });
  it.each(['example.com', 'evil.attacker.net', 'dev.example.com', ''])('does not exempt %s', (h) => {
    expect(isAlwaysAllowed(h)).toBe(false);
  });
});

describe('parseDomainEntry', () => {
  it('accepts domains, wildcards and URLs', () => {
    expect(parseDomainEntry('Dev.Example.com')).toBe('dev.example.com');
    expect(parseDomainEntry('https://dev.example.com/path?x=1')).toBe('dev.example.com');
    expect(parseDomainEntry('dev.example.com:8443')).toBe('dev.example.com');
    expect(parseDomainEntry('*.example.com')).toBe('*.example.com');
  });
  it('rejects junk', () => {
    for (const bad of ['', 'localhost', 'not a domain', '*.', '-x.com', 'a..b.com', 'http://', '<script>.com']) {
      expect(parseDomainEntry(bad), bad).toBeNull();
    }
  });
  it('parses a list from text, de-duplicated and reporting bad entries', () => {
    expect(parseDomainList('a.example.com, b.example.com\nA.example.com nonsense!')).toEqual({ list: ['a.example.com', 'b.example.com'], bad: ['nonsense!'] });
  });
});

describe('hostAllowed', () => {
  it('without an allow-list everything is accepted (unchanged behaviour)', () => {
    expect(hostAllowed('anything.example.org', [])).toBe(true);
  });
  const allowed = ['dev.example.com', '*.team.example.org'];
  it('accepts listed names (any port) and wildcard subdomains', () => {
    expect(hostAllowed('dev.example.com', allowed)).toBe(true);
    expect(hostAllowed('DEV.example.com:443', allowed)).toBe(true);
    expect(hostAllowed('a.team.example.org', allowed)).toBe(true);
    expect(hostAllowed('x.y.team.example.org', allowed)).toBe(true);
  });
  it('rejects other domains, including look-alikes and the bare wildcard base', () => {
    expect(hostAllowed('evil.com', allowed)).toBe(false);
    expect(hostAllowed('dev.example.com.evil.com', allowed)).toBe(false);
    expect(hostAllowed('xdev.example.com', allowed)).toBe(false);
    expect(hostAllowed('team.example.org', allowed)).toBe(false);
    expect(hostAllowed('', allowed)).toBe(false);
  });
  it('local access always works even with a list', () => {
    for (const h of ['localhost:3011', '127.0.0.1:3001', '192.168.0.9:3011', '[::1]:3001', 'myserver:3011']) expect(hostAllowed(h, allowed), h).toBe(true);
  });
});

describe('requestAllowed (strict mode)', () => {
  const allowed = ['dev.example.com'];
  const req = (over: Partial<Parameters<typeof requestAllowed>[0]>) => requestAllowed({ host: 'dev.example.com', allowed, strict: true, fromThisMachine: false, relayed: false, ...over });
  it('normal mode keeps the old rule (IPs and local names pass)', () => {
    expect(req({ strict: false, host: '98.92.70.208' })).toBe(true);
    expect(req({ strict: false, host: 'evil.example.org' })).toBe(false);
  });
  it('strict: only the allowed domains from outside — IP, bare names and a forged localhost are refused', () => {
    expect(req({})).toBe(true);
    expect(req({ host: '98.92.70.208' })).toBe(false);
    expect(req({ host: 'myserver' })).toBe(false);
    expect(req({ host: 'localhost' })).toBe(false);
    expect(req({ host: 'other.example.com' })).toBe(false);
  });
  it('strict: this machine itself still works, unless the request was relayed by a proxy or tunnel', () => {
    expect(req({ host: 'localhost', fromThisMachine: true })).toBe(true);
    expect(req({ host: 'orchestrator', fromThisMachine: true })).toBe(true);
    expect(req({ host: '98.92.70.208', fromThisMachine: true, relayed: true })).toBe(false);
  });
  it('strict without any domain does nothing (it would block everyone)', () => {
    expect(requestAllowed({ host: '1.2.3.4', allowed: [], strict: true, fromThisMachine: false, relayed: false })).toBe(true);
  });
});
