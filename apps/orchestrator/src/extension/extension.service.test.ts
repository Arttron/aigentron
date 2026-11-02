import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExtensionService } from './extension.service';

// the template is the BUILD output of apps/extension (built here with the real build script, into a temp dir)
const TEMPLATE = (() => {
  const out = mkdtempSync(join(tmpdir(), 'ext-tpl-'));
  execFileSync(process.execPath, [join(__dirname, '..', '..', '..', 'extension', 'build.mjs'), '--out', out], { stdio: 'pipe' });
  return out;
})();
const make = () => new ExtensionService({ secretsDir: mkdtempSync(join(tmpdir(), 'ext-s-')), extensionDir: TEMPLATE } as never);

describe('ExtensionService (the shipped template)', () => {
  it('keeps one key per server: the same id every time, a different one on another server', () => {
    const a = make();
    expect(a.extensionId()).toBe(a.extensionId());
    expect(a.extensionId()).toMatch(/^[a-p]{32}$/);
    expect(make().extensionId()).not.toBe(a.extensionId());
  });

  it('builds a zip whose manifest holds this server\'s addresses only, a key, and no secret', async () => {
    const svc = make();
    const { zip, fileName, extensionId } = await svc.buildZip(['https://aigentron.example.com', 'http://localhost:3011']);
    expect(fileName).toBe('aigentron-extension-aigentron.example.com.zip');
    const dir = mkdtempSync(join(tmpdir(), 'ext-z-'));
    writeFileSync(join(dir, 'p.zip'), zip);
    try {
      execFileSync('unzip', ['-q', join(dir, 'p.zip'), '-d', join(dir, 'x')]);
    } catch {
      return; // no unzip on this machine
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'x', 'manifest.json'), 'utf8')) as Record<string, unknown> & { content_scripts: { matches: string[] }[] };
    expect(manifest.host_permissions).toEqual(['https://aigentron.example.com/*', 'http://localhost:3011/*']);
    expect(manifest.content_scripts[0]!.matches).toEqual(['https://aigentron.example.com/*', 'http://localhost:3011/*']);
    expect(manifest.key).toBe(svc.key().publicKeyDer);
    expect(String(manifest.name)).toContain('aigentron.example.com');
    const config = JSON.parse(readFileSync(join(dir, 'x', 'config.json'), 'utf8')) as { origins: string[]; extensionId: string };
    expect(config).toMatchObject({ origins: ['https://aigentron.example.com', 'http://localhost:3011'], extensionId });
    // everything the extension needs is there, and the private key is nowhere in the archive
    for (const f of ['background.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'lib/api.js', 'lib/store.js', 'icons/16.png', 'icons/128.png']) {
      expect(() => readFileSync(join(dir, 'x', f)), f).not.toThrow();
    }
    expect(() => readFileSync(join(dir, 'x', 'README.md'))).toThrow();
    expect(zip.includes(Buffer.from('PRIVATE KEY'))).toBe(false);
    expect(zip.includes(Buffer.from(svc.key().privateKeyPem.split('\n')[1]!))).toBe(false);
  });

  it('a paired extension updating itself may keep the addresses it already has', () => {
    const svc = make();
    expect(svc.originsFor('https://a.example.com', ['http://localhost:3011', 'https://b.example.com'], true)).toEqual(['https://a.example.com', 'http://localhost:3011', 'https://b.example.com']);
    expect(svc.originsFor('https://a.example.com', ['http://localhost:3011'], false)).toEqual(['https://a.example.com']);
  });

  it('extra addresses are accepted only on the host of the request or PUBLIC_URL', () => {
    const svc = make();
    expect(svc.originsFor('http://localhost:3011', ['http://localhost:3088', 'http://evil.example:3088', 'javascript:1'])).toEqual(['http://localhost:3011', 'http://localhost:3088']);
    expect(svc.originsFor('https://a.example.com', ['https://a.example.com:8443', 'https://b.example.com'])).toEqual(['https://a.example.com', 'https://a.example.com:8443']);
  });
});
