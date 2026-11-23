import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetName, installScript, isPlatform, LOCAL_PLATFORMS, parseSums, safeOrigin } from './install-script';

describe('install script and assets', () => {
  it('names the assets the release builds', () => {
    expect(assetName('0.1.130', 'darwin', 'arm64')).toBe('aigentron-local_0.1.130_darwin_arm64.tar.gz');
    expect(assetName('0.1.130', 'windows', 'amd64')).toBe('aigentron-local_0.1.130_windows_amd64.zip');
  });
  it('knows only the built platforms', () => {
    expect(isPlatform('linux', 'arm64')).toBe(true);
    expect(isPlatform('windows', 'arm64')).toBe(false);
    expect(isPlatform('../x', 'amd64')).toBe(false);
  });
  it('reads sha256sum lines', () => {
    const h = 'a'.repeat(64);
    const m = parseSums(`${h}  one.tar.gz\n${h.toUpperCase().replace(/A/g, 'B')} *two.zip\nnot a line\n`);
    expect(m.get('one.tar.gz')).toBe(h);
    expect(m.get('two.zip')).toBe('b'.repeat(64));
    expect(m.size).toBe(2);
  });
  it('puts only a plain origin into the shell script', () => {
    expect(safeOrigin('https://dev.example.com')).toBe(true);
    expect(safeOrigin('http://localhost:3001')).toBe(true);
    for (const bad of ['https://x.com/;rm -rf ~', 'https://x.com"; id; "', 'javascript:alert(1)', 'https://x.com\nid', '$(id)', 'https://a b']) {
      expect(safeOrigin(bad)).toBe(false);
      expect(() => installScript(bad)).toThrow();
    }
    const s = installScript('https://dev.example.com');
    expect(s).toContain('SERVER="${AIGENTRON_SERVER:-https://dev.example.com}"');
    expect(s.startsWith('#!/bin/sh')).toBe(true);
    expect(s).toContain('aigentron" login --server "$SERVER"');
    expect(s).toContain('"$BIN_DIR/aigentron"'); // installed as `aigentron`, the old name kept as a link
    expect(s).toContain('ln -sf aigentron "$BIN_DIR/aigentron-local"');
    expect(s).toContain('does not match');
  });
  it('build.sh builds exactly the platforms the server hands out', () => {
    const sh = readFileSync(join(__dirname, '../../../local-agent/build.sh'), 'utf8');
    const listed = /^platforms="([^"]+)"/m.exec(sh)?.[1]?.split(/\s+/).sort();
    expect(listed).toEqual(LOCAL_PLATFORMS.map((p) => `${p.os}/${p.arch}`).sort());
  });
});
