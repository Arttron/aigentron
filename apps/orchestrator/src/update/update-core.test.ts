import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRunnerScript, cleanVersion, compareVersions, parseRelease, parseVersion, resolveStaleStatus, shq } from './update-core';

describe('versions', () => {
  it('parses and compares', () => {
    expect(parseVersion('v0.1.47')).toEqual([0, 1, 47]);
    expect(parseVersion('dev')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('0.1')).toBeNull();
    expect(parseVersion('0.1.47; rm -rf /')).toBeNull();
    expect(compareVersions('0.1.48', '0.1.47')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.1.99')).toBeGreaterThan(0);
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0);
    expect(compareVersions('0.1.47', 'v0.1.47')).toBe(0);
    expect(compareVersions('dev', '0.1.47')).toBe(0);
    expect(cleanVersion(' v1.2.3 ')).toBe('1.2.3');
  });
});

describe('shq', () => {
  it('survives single quotes', () => expect(shq("a'b")).toBe(`'a'\\''b'`));
});

describe('buildRunnerScript', () => {
  const o = { repo: 'Arttron/aigentron', version: 'v0.1.48', installDir: '/opt/aigentron', dataDir: "/opt/aigentron/da'ta", stateDir: '/opt/aigentron/data/update' };
  it('fetches the target release installer and runs it in bare-metal mode', () => {
    const s = buildRunnerScript(o);
    expect(s).toContain('https://raw.githubusercontent.com/Arttron/aigentron/v$VERSION/install.sh');
    expect(s).toContain("VERSION='0.1.48'");
    expect(s).toContain('INSTALL_MODE=bare');
    expect(s).toContain(`DATA_DIR='/opt/aigentron/da'\\''ta'`);
    expect(s).toContain('status.json');
  });
  it('verifies install.sh against SHA256SUMS and is valid sh', () => {
    const s = buildRunnerScript(o);
    expect(s).toContain('releases/download/v$VERSION/SHA256SUMS');
    expect(s).toContain('&& verify_installer');
    const dir = mkdtempSync(join(tmpdir(), 'runner-'));
    writeFileSync(join(dir, 'r.sh'), s);
    expect(() => execFileSync('sh', ['-n', join(dir, 'r.sh')])).not.toThrow();
  });
  it('refuses a bad version or repository (no shell injection through them)', () => {
    expect(() => buildRunnerScript({ ...o, version: '0.1.48; reboot' })).toThrow();
    expect(() => buildRunnerScript({ ...o, repo: 'a/b;c' })).toThrow();
  });
});

describe('parseRelease', () => {
  it('reads a GitHub release', () => {
    expect(parseRelease({ tag_name: 'v0.1.47', body: 'notes', html_url: 'https://x', published_at: '2026-10-09T00:00:00Z' })).toEqual({ version: '0.1.47', notes: 'notes', url: 'https://x', publishedAt: '2026-10-09T00:00:00Z' });
    expect(parseRelease({ tag_name: 'nightly' })).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });
});

describe('resolveStaleStatus', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const base = { state: 'running' as const, version: '0.1.59', startedAt: '2026-10-15T11:50:00Z', finishedAt: '', error: '' };
  it('keeps a recent running update', () => expect(resolveStaleStatus(base, now).state).toBe('running'));
  it('turns a running update older than 30 minutes into failed', () => {
    const r = resolveStaleStatus({ ...base, startedAt: '2026-10-15T11:20:00Z' }, now);
    expect(r.state).toBe('failed');
    expect(r.error).toContain('30 minutes');
    expect(r.finishedAt).not.toBe('');
  });
  it('treats an unreadable start time as stale and leaves ok/failed alone', () => {
    expect(resolveStaleStatus({ ...base, startedAt: 'garbage' }, now).state).toBe('failed');
    expect(resolveStaleStatus({ ...base, state: 'ok' as const, startedAt: '2020-01-01T00:00:00Z' }, now).state).toBe('ok');
  });
});
