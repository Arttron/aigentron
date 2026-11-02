import { describe, expect, it } from 'vitest';
import { createZip } from '../../../orchestrator/src/extension/zip';
// @ts-expect-error plain JS modules of the extension
import { compareVersions, updateAvailable } from './version.js';
// @ts-expect-error plain JS modules of the extension
import { crc32, readZip } from './unzip.js';
// @ts-expect-error plain JS modules of the extension
import { applyUpdate, checkCompatible, listFiles, planUpdate } from './update-core.js';

describe('versions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.1.104', '0.1.99')).toBe(1);
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(updateAvailable('0.1.99', '0.1.104')).toBe(true);
    expect(updateAvailable('0.1.104', '0.1.104')).toBe(false);
    expect(updateAvailable('0.1.104', 'dev')).toBe(false);
    expect(updateAvailable('0.1.104', null)).toBe(false);
  });
});

describe('reading the zip the server builds', () => {
  const files = [
    { name: 'manifest.json', data: Buffer.from('{"a":1}'.repeat(100)) },
    { name: 'icons/16.png', data: Buffer.from([1, 2, 3, 4]) },
    { name: 'lib/дом.js', data: Buffer.from('export {}') },
  ];
  it('round-trips every file, deflated or stored', async () => {
    const m = await readZip(new Uint8Array(createZip(files)));
    expect([...m.keys()]).toEqual(['manifest.json', 'icons/16.png', 'lib/дом.js']);
    expect(Buffer.from(m.get('manifest.json')).toString()).toBe('{"a":1}'.repeat(100));
    expect([...m.get('icons/16.png')]).toEqual([1, 2, 3, 4]);
  });
  it('refuses damage: a flipped byte (checksum), junk, a truncated archive', async () => {
    const zip = new Uint8Array(createZip(files));
    const bad = new Uint8Array(zip);
    bad[46] ^= 0xff; // inside the first file's data (after its 30-byte header and 13-byte name)
    await expect(readZip(bad)).rejects.toThrow();
    await expect(readZip(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(/not a zip/);
    await expect(readZip(zip.subarray(0, zip.length - 30))).rejects.toThrow();
  });
  it('crc32 matches the standard value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('may the update replace the running extension on its own?', () => {
  const old = { manifest_version: 3, version: '0.1.99', key: 'K', permissions: ['storage', 'alarms'], host_permissions: ['https://a.example.com/*'], optional_host_permissions: ['<all_urls>'] };
  it('yes: same key, newer, no new powers (fewer is fine)', () => {
    expect(checkCompatible(old, { ...old, version: '0.1.104' })).toEqual({ ok: true, reasons: [] });
    expect(checkCompatible(old, { ...old, version: '0.1.104', permissions: ['storage'] }).ok).toBe(true);
  });
  it('no: another extension, not newer, a new permission, a new address', () => {
    expect(checkCompatible(old, { ...old, version: '0.1.104', key: 'OTHER' }).reasons.join()).toContain('different extension');
    expect(checkCompatible(old, { ...old, version: '0.1.99' }).reasons.join()).toContain('not newer');
    expect(checkCompatible(old, { ...old, version: '0.1.104', permissions: ['storage', 'alarms', 'tabs'] }).reasons.join()).toContain('tabs');
    expect(checkCompatible(old, { ...old, version: '0.1.104', host_permissions: ['https://a.example.com/*', 'https://evil.example/*'] }).reasons.join()).toContain('new addresses');
    expect(checkCompatible(old, { ...old, version: '0.1.104', optional_host_permissions: ['<all_urls>', 'https://x/*'] }).ok).toBe(false);
    expect(checkCompatible(old, null as never).ok).toBe(false);
  });
});

/** An in-memory FileSystemDirectoryHandle: just what the updater uses. */
function memDir(tree: Record<string, unknown> = {}): { entries(): AsyncGenerator<[string, unknown]>; getDirectoryHandle(n: string, o?: { create?: boolean }): Promise<unknown>; getFileHandle(n: string, o?: { create?: boolean }): Promise<unknown>; removeEntry(n: string): Promise<void>; kind: string; tree: Record<string, unknown> } {
  const self = {
    kind: 'directory',
    tree,
    async *entries() {
      for (const [n, v] of Object.entries(tree)) yield [n, v instanceof Uint8Array ? { kind: 'file', name: n } : memDir(v as Record<string, unknown>)] as [string, unknown];
    },
    async getDirectoryHandle(n: string, o?: { create?: boolean }) {
      if (!(n in tree)) {
        if (!o?.create) throw new Error('NotFoundError');
        tree[n] = {};
      }
      return memDir(tree[n] as Record<string, unknown>);
    },
    async getFileHandle(n: string, o?: { create?: boolean }) {
      if (!(n in tree) && !o?.create) throw new Error('NotFoundError');
      return {
        async createWritable() {
          return { async write(d: Uint8Array) { tree[n] = d; }, async close() {} };
        },
      };
    },
    async removeEntry(n: string) {
      if (!(n in tree)) throw new Error('NotFoundError');
      delete tree[n];
    },
  };
  return self;
}

describe('writing the update into the folder', () => {
  it('plans the manifest last and the stale files for removal', () => {
    const fresh = new Map([['manifest.json', new Uint8Array([1])], ['background.js', new Uint8Array([2])], ['lib/a.js', new Uint8Array([3])]]);
    expect(planUpdate(fresh, ['manifest.json', 'old.js', 'lib/a.js', 'lib/gone.js'])).toEqual({ write: ['background.js', 'lib/a.js', 'manifest.json'], remove: ['lib/gone.js', 'old.js'] });
  });
  it('leaves alone what is not an extension file or lies outside the folders the package fills', () => {
    const fresh = new Map([['manifest.json', new Uint8Array([1])], ['lib/a.js', new Uint8Array([3])]]);
    expect(planUpdate(fresh, ['manifest.json', 'lib/a.js', 'notes.txt', 'photos/me.png', '.git/config', 'old.js']).remove).toEqual(['old.js']);
  });
  it('refuses a package with paths that climb out of the folder', () => {
    for (const bad of ['../evil.js', '/etc/x.js', 'a/../../x.js', 'a\\\\b.js', 'a//b.js']) {
      expect(() => planUpdate(new Map([[bad, new Uint8Array([1])]]), []), bad).toThrow(/not allowed/);
    }
  });
  it('replaces files, creates folders, removes what is gone', async () => {
    const root = memDir({ 'manifest.json': new Uint8Array([9]), 'old.js': new Uint8Array([9]), lib: { 'a.js': new Uint8Array([9]), 'gone.js': new Uint8Array([9]) } });
    const fresh = new Map([['manifest.json', new Uint8Array([1])], ['lib/a.js', new Uint8Array([3])], ['icons/16.png', new Uint8Array([4])]]);
    const existing = await listFiles(root);
    expect(existing.sort()).toEqual(['lib/a.js', 'lib/gone.js', 'manifest.json', 'old.js']);
    const r = await applyUpdate(root, fresh, existing);
    expect(r).toEqual({ written: 3, removed: 2 });
    expect((await listFiles(root)).sort()).toEqual(['icons/16.png', 'lib/a.js', 'manifest.json']);
    expect([...(root.tree['manifest.json'] as Uint8Array)]).toEqual([1]);
  });
});
