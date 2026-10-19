import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectSecretsStore } from './project-secrets';
import { generateEd25519 } from './ssh-keys';

let base: string;
let store: ProjectSecretsStore;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lds-psecrets-'));
  store = new ProjectSecretsStore(join(base, 'secrets'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;

describe('ProjectSecretsStore', () => {
  it('keeps files under <secrets>/projects/<slug> with dir 0700 and files 0600, written atomically', () => {
    store.writeToken('alpha', 'ghp_abcdef1234');
    const dir = join(base, 'secrets', 'projects', 'alpha');
    expect(mode(join(base, 'secrets', 'projects'))).toBe(0o700);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, 'token'))).toBe(0o600);
    expect(readFileSync(join(dir, 'token'), 'utf8')).toBe('ghp_abcdef1234\n');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]); // no temp file left behind
    expect(store.readToken('alpha')).toBe('ghp_abcdef1234');
    expect(store.tokenHint('alpha')).toBe('…1234');
    expect(store.hasToken('alpha')).toBe(true);
    expect(store.modes('alpha')).toEqual({ '.': 0o700, token: 0o600 });
  });

  it('rejects slugs that are not project slugs (no path tricks)', () => {
    for (const bad of ['../x', 'a/b', 'A', '', '.', '-x', 'x'.repeat(41), 'with space']) expect(() => store.dirOf(bad)).toThrow(/invalid project slug/);
    expect(store.dirOf('default')).toBe(join(base, 'secrets', 'projects', 'default'));
  });

  it('validates tokens (no spaces / newlines, a length limit) and trims', () => {
    expect(() => store.writeToken('a', '')).toThrow(/empty/);
    expect(() => store.writeToken('a', 'has space')).toThrow(/spaces/);
    expect(() => store.writeToken('a', 'x'.repeat(5000))).toThrow(/too long/);
    store.writeToken('a', '  tok\n');
    expect(store.readToken('a')).toBe('tok');
    store.clearToken('a');
    expect(store.readToken('a')).toBeNull();
    expect(store.tokenHint('a')).toBeNull();
    store.clearToken('a'); // idempotent
  });

  it('stores an ssh key pair (0600 both), reads back only the public side and the fingerprint', () => {
    const k = generateEd25519('aigentron:a@h');
    store.writeSshKey('a', k);
    const dir = store.dirOf('a');
    expect(mode(join(dir, 'id_ed25519'))).toBe(0o600);
    expect(mode(join(dir, 'id_ed25519.pub'))).toBe(0o600);
    const back = store.readSshKey('a')!;
    expect(back.privateKeyPath).toBe(join(dir, 'id_ed25519'));
    expect(back.publicKey).toBe(k.publicKey);
    expect(back.fingerprint).toBe(k.fingerprint);
    expect(Object.keys(back)).not.toContain('privateKey');
    expect(readFileSync(back.privateKeyPath, 'utf8')).toBe(k.privateKey);
    store.clearSshKey('a');
    expect(store.readSshKey('a')).toBeNull();
    expect(existsSync(join(dir, 'id_ed25519.pub'))).toBe(false);
  });

  it('creates an empty known_hosts (0600) on demand and clears it', () => {
    const p = store.knownHostsPath('b');
    expect(existsSync(p)).toBe(true);
    expect(mode(p)).toBe(0o600);
    expect(store.readKnownHosts('b')).toBe('');
    store.clearKnownHosts('b');
    expect(existsSync(p)).toBe(false);
    expect(store.readKnownHosts('b')).toBe('');
  });

  it('keeps the last test and clears everything with clearAll', () => {
    store.writeLastTest('c', { at: '2026-10-19T10:00:00Z', ok: false, summary: 'Access: rejected', durationMs: 12 });
    expect(store.readLastTest('c')).toEqual({ at: '2026-10-19T10:00:00Z', ok: false, summary: 'Access: rejected', durationMs: 12 });
    store.writeToken('c', 't0ken');
    store.clearAll('c');
    expect(existsSync(store.dirOf('c'))).toBe(false);
    expect(store.readLastTest('c')).toBeNull();
    expect(store.readToken('c')).toBeNull();
  });

  it('re-asserts 0700 on an existing directory', () => {
    store.ensureDir('d');
    rmSync(store.dirOf('d'), { recursive: true });
    store.ensureDir('d');
    expect(mode(store.dirOf('d'))).toBe(0o700);
  });
});
