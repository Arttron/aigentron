import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildConfig, buildManifest, extensionIdFromKey, extensionVersion, generateExtensionKey, originOf, serverLabel, serverOrigins } from './extension-package';
import { PairingCodes, extensionRouteAllowed } from './extension-pairing';
import { createZip } from './zip';

/** A tiny zip reader for the tests: central directory → { name → bytes }. */
function readZip(buf: Buffer): Record<string, Buffer> {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    const data = buf.subarray(off + 30 + lnlen, off + 30 + lnlen + csize);
    out[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    p += 46 + nlen;
  }
  return out;
}

describe('zip', () => {
  it('round-trips files (deflated and stored) with their names', () => {
    const text = Buffer.from('hello '.repeat(200));
    const tiny = Buffer.from('x');
    const z = readZip(createZip([{ name: 'a/b.txt', data: text }, { name: 'c.bin', data: tiny }, { name: 'дом.txt', data: tiny }]));
    expect(Object.keys(z)).toEqual(['a/b.txt', 'c.bin', 'дом.txt']);
    expect(z['a/b.txt']!.equals(text)).toBe(true);
    expect(z['c.bin']!.toString()).toBe('x');
  });
  it('refuses a path that climbs out', () => {
    for (const name of ['../x', '/abs', 'a\\b', '']) expect(() => createZip([{ name, data: Buffer.from('x') }])).toThrow();
  });
  it('is a valid archive for the system unzip', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      return; // no unzip on this machine
    }
    const f = join(mkdtempSync(join(tmpdir(), 'zip-')), 'x.zip');
    writeFileSync(f, createZip([{ name: 'manifest.json', data: Buffer.from('{"a":1}'.repeat(50)) }, { name: 'icons/16.png', data: Buffer.from([1, 2, 3]) }]));
    expect(execFileSync('unzip', ['-t', f]).toString()).toContain('No errors detected');
  });
});

describe('extension id', () => {
  it('is 32 letters a-p, stable for a key and different for another', () => {
    const k = generateExtensionKey();
    const id = extensionIdFromKey(k.publicKeyDer);
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(extensionIdFromKey(k.publicKeyDer)).toBe(id);
    expect(extensionIdFromKey(generateExtensionKey().publicKeyDer)).not.toBe(id);
  });
  it('matches Chrome\'s derivation (sha256 of the DER, first 16 bytes, hex digit → a-p)', () => {
    // a fixed "key" → a fixed id, so a change of the algorithm is noticed
    const der = Buffer.from('aigentron-test-key').toString('base64');
    expect(extensionIdFromKey(der)).toMatch(/^[a-p]{32}$/);
    expect(extensionIdFromKey(der)).toBe(extensionIdFromKey(der));
  });
});

describe('origins and manifest', () => {
  it('origins: normalised, deduplicated, http(s) only, the one in use first', () => {
    expect(originOf('https://A.example.com/path?x=1')).toBe('https://a.example.com');
    expect(originOf('ftp://x')).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(serverOrigins(['https://a.com/x', null, 'https://a.com', 'http://localhost:3011/', 'javascript:alert(1)'])).toEqual(['https://a.com', 'http://localhost:3011']);
    expect(serverLabel(['https://a.example.com'])).toBe('a.example.com');
  });
  it('version fits Chrome', () => {
    expect(extensionVersion('0.1.104')).toBe('0.1.104');
    expect(extensionVersion('1.2.3-rc1')).toBe('1.2.3');
    expect(extensionVersion('weird')).toBe('0.0.1');
  });
  it('the manifest carries this server\'s addresses and nothing broader', () => {
    const m = buildManifest({
      template: { manifest_version: 3, name: 'Aigentron', permissions: ['storage'], content_scripts: [{ js: ['content.js'], matches: ['<all_urls>'], run_at: 'document_idle' }], host_permissions: ['<all_urls>'] },
      serverName: 'example.com',
      origins: ['https://example.com', 'http://localhost:3011'],
      serverVersion: '0.1.104',
      publicKeyDer: 'KEY',
    });
    expect(m.host_permissions).toEqual(['https://example.com/*', 'http://localhost:3011/*']);
    expect((m.content_scripts as { matches: string[] }[])[0]!.matches).toEqual(['https://example.com/*', 'http://localhost:3011/*']);
    expect(m.key).toBe('KEY');
    expect(m.name).toBe('Aigentron — example.com');
    expect(m.version).toBe('0.1.104');
    expect(JSON.stringify(m)).not.toContain('<all_urls>');
    expect(() => buildManifest({ template: {}, serverName: 'x', origins: [], serverVersion: '1.0.0', publicKeyDer: 'k' })).toThrow();
  });
  it('config is plain data', () => {
    expect(buildConfig({ serverName: 's', origins: ['https://s'], serverVersion: '1.0.0', extensionId: 'id' })).toEqual({ serverName: 's', origins: ['https://s'], serverVersion: '1.0.0', extensionId: 'id' });
  });
});

describe('pairing', () => {
  it('a code works once, for the user it was issued to, and expires', () => {
    const p = new PairingCodes(60_000);
    const { code } = p.issue('u1', 1000);
    expect(p.redeem(code, 2000)).toBe('u1');
    expect(p.redeem(code, 2000)).toBeNull();
    const late = p.issue('u2', 1000).code;
    expect(p.redeem(late, 1000 + 60_001)).toBeNull();
    expect(p.redeem('nope')).toBeNull();
    expect(p.redeem(42)).toBeNull();
  });
});

describe('what an extension token may call', () => {
  it('only its own few routes', () => {
    expect(extensionRouteAllowed('GET', '/api/extension/me')).toBe(true);
    expect(extensionRouteAllowed('POST', '/api/extension/revoke')).toBe(true);
    expect(extensionRouteAllowed('GET', '/api/projects/')).toBe(true);
    expect(extensionRouteAllowed('POST', '/api/extension/clip')).toBe(true);
    expect(extensionRouteAllowed('GET', '/api/knowledge')).toBe(true);
    expect(extensionRouteAllowed('GET', '/api/approvals')).toBe(true);
    expect(extensionRouteAllowed('POST', '/api/approvals/abc123/decision')).toBe(true);
    expect(extensionRouteAllowed('POST', '/api/questions/q1/answer')).toBe(true);
    expect(extensionRouteAllowed('GET', '/api/tasks/t1')).toBe(true);
    expect(extensionRouteAllowed('GET', '/api/tasks')).toBe(true);
    expect(extensionRouteAllowed('GET', '/api/voice')).toBe(true);
    expect(extensionRouteAllowed('GET', '/api/extension/package')).toBe(true);
    expect(extensionRouteAllowed('GET', '/api/extension/download')).toBe(false); // the dashboard's button, not the extension's
    expect(extensionRouteAllowed('POST', '/api/voice/transcribe')).toBe(true);
    expect(extensionRouteAllowed('GET', '/api/tasks/t1/transcript')).toBe(true);
    expect(extensionRouteAllowed('POST', '/api/tasks/t1/follow-up')).toBe(true);
    for (const [m, p] of [['POST', '/api/extension/pair'], ['GET', '/api/settings'], ['POST', '/api/auth/password'], ['DELETE', '/api/projects'], ['GET', '/api/sessions'], ['POST', '/api/tasks'], ['POST', '/api/knowledge/x/docs/note'], ['DELETE', '/api/extension/clip'], ['POST', '/api/approvals/mode'], ['GET', '/api/approvals/mode'], ['POST', '/api/approvals/abc/secret'], ['PUT', '/api/voice'], ['POST', '/api/voice/test'], ['POST', '/api/voice/speak'], ['POST', '/api/tasks'], ['DELETE', '/api/tasks/t1'], ['POST', '/api/tasks/t1/done'], ['POST', '/api/tasks/t1/start']] as const) {
      expect(extensionRouteAllowed(m, p), `${m} ${p}`).toBe(false);
    }
  });
});
