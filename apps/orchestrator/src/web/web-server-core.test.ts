import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WEB_CONFIG, inspectCertificate, nameCovers, parseWebConfig, redirectTarget } from './web-server-core';

function makeCert(cn: string, san: string, days = 30): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', String(days), '-subj', `/CN=${cn}`, '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
    return { cert: readFileSync(join(dir, 'c.pem'), 'utf8'), key: readFileSync(join(dir, 'k.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('parseWebConfig', () => {
  it('defaults, and validation', () => {
    expect(parseWebConfig({}, 3001)).toEqual({ ok: true, config: DEFAULT_WEB_CONFIG });
    expect(DEFAULT_WEB_CONFIG.httpPort).toBe(0);
    expect(parseWebConfig({ httpPort: 8080, httpsPort: '8443', redirect: false }, 3001)).toEqual({ ok: true, config: { httpPort: 8080, httpsPort: 8443, redirect: false } });
    expect(parseWebConfig({ httpPort: 80 }, 3001)).toMatchObject({ ok: true, config: { httpPort: 80, httpsPort: 443 } });
    expect(parseWebConfig({ httpPort: 99999 }, 3001)).toMatchObject({ ok: false });
    expect(parseWebConfig({ httpPort: 'abc' }, 3001)).toMatchObject({ ok: false });
    expect(parseWebConfig({ httpPort: 443, httpsPort: 443 }, 3001)).toMatchObject({ ok: false });
    expect(parseWebConfig({ httpsPort: 3001 }, 3001)).toMatchObject({ ok: false });
  });
});

describe('nameCovers / redirectTarget', () => {
  it('wildcards cover one label only', () => {
    expect(nameCovers('dev.example.com', 'dev.example.com')).toBe(true);
    expect(nameCovers('*.example.com', 'dev.example.com')).toBe(true);
    expect(nameCovers('*.example.com', 'a.b.example.com')).toBe(false);
    expect(nameCovers('*.example.com', 'example.com')).toBe(false);
  });
  it('redirects domain names only', () => {
    expect(redirectTarget('dev.example.com', '/a?b=1', 443)).toBe('https://dev.example.com/a?b=1');
    expect(redirectTarget('dev.example.com:80', '/', 8443)).toBe('https://dev.example.com:8443/');
    expect(redirectTarget('192.168.1.5', '/', 443)).toBeNull();
    expect(redirectTarget('localhost', '/', 443)).toBeNull();
    expect(redirectTarget('myhost', '/', 443)).toBeNull();
    expect(redirectTarget(undefined, '/', 443)).toBeNull();
  });
});

describe('inspectCertificate', () => {
  const good = makeCert('dev.example.com', 'DNS:dev.example.com,DNS:*.team.example.com');
  it('reads names and expiry, and checks the key', () => {
    const r = inspectCertificate(good.cert, good.key);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.names).toEqual(['dev.example.com', '*.team.example.com']);
      expect(r.info.subject).toBe('dev.example.com');
      expect(r.info.daysLeft).toBeGreaterThanOrEqual(29);
      expect(r.info.selfSigned).toBe(true);
    }
  });
  it('rejects a mismatched key, garbage, and an expired certificate', () => {
    const other = makeCert('other.example.com', 'DNS:other.example.com');
    expect(inspectCertificate(good.cert, other.key)).toMatchObject({ ok: false, error: expect.stringMatching(/does not belong/) });
    expect(inspectCertificate('nope')).toMatchObject({ ok: false });
    expect(inspectCertificate(good.cert, 'nope')).toMatchObject({ ok: false, error: expect.stringMatching(/private key/) });
    expect(inspectCertificate(good.cert, good.key, Date.now() + 90 * 86_400_000)).toMatchObject({ ok: false, error: expect.stringMatching(/expired/) });
  });
});
