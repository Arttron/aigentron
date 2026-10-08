import { describe, expect, it } from 'vitest';
import { hostAllowed, isAlwaysAllowed, normalizeHost, parseDomainEntry, parseDomainList } from './access-core';

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
