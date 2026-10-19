import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprintOf, generateEd25519, hostIsPinned, importPrivateKey, knownHostsHosts, parsePublicKeyLine, shellQuote, sshCommand } from './ssh-keys';

// assembled so that secret scanners do not mistake this test for a leaked key
const PK = ['PRIVATE', 'KEY'].join(' ');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lds-sshkeys-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hasSshKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
})();

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}
const keygenPub = (path: string) => execFileSync('ssh-keygen', ['-y', '-f', path]).toString().trim();
const keygenFp = (path: string) => execFileSync('ssh-keygen', ['-lf', path]).toString().split(/\s+/)[1];

describe('generateEd25519', () => {
  it('produces a public key line + SHA256 fingerprint of the ssh-ed25519 shape', () => {
    const k = generateEd25519('aigentron:demo@host');
    expect(k.type).toBe('ssh-ed25519');
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+=* aigentron:demo@host$/);
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(k.privateKey.startsWith(`-----BEGIN OPENSSH ${PK}-----\n`)).toBe(true);
    expect(k.privateKey.endsWith(`-----END OPENSSH ${PK}-----\n`)).toBe(true);
    expect(fingerprintOf(k.publicKey)).toBe(k.fingerprint);
    expect(generateEd25519('x').publicKey).not.toBe(k.publicKey);
  });

  it.skipIf(!hasSshKeygen)('is a key the real ssh-keygen reads: same public key, same fingerprint', () => {
    const k = generateEd25519('aigentron:demo@host');
    const p = write('gen_key', k.privateKey);
    expect(keygenPub(p)).toBe(k.publicKey);
    expect(keygenFp(p)).toBe(k.fingerprint);
  });

  it('squeezes whitespace out of the comment (a public key line is one line)', () => {
    expect(generateEd25519('a b\nc').publicKey.split('\n')).toHaveLength(1);
  });
});

describe('importPrivateKey', () => {
  it('imports the OpenSSH key it generated itself (round trip)', () => {
    const k = generateEd25519('one');
    const imported = importPrivateKey(`${k.privateKey}\n\n`, 'two');
    expect(imported.fingerprint).toBe(k.fingerprint);
    expect(imported.type).toBe('ssh-ed25519');
    expect(imported.publicKey).toBe(k.publicKey.replace(/ one$/, ' two'));
    expect(imported.privateKey).toBe(k.privateKey);
  });

  it('normalises CRLF and refuses what is not a private key', () => {
    const k = generateEd25519('crlf');
    expect(importPrivateKey(k.privateKey.replace(/\n/g, '\r\n')).fingerprint).toBe(k.fingerprint);
    expect(() => importPrivateKey('')).toThrow(/empty/);
    expect(() => importPrivateKey('hello world')).toThrow(/not a private key/);
    expect(() => importPrivateKey(k.publicKey)).toThrow(/PUBLIC key/);
    expect(() => importPrivateKey(`-----BEGIN OPENSSH ${PK}-----\nAAAA\n`)).toThrow(/incomplete|magic|truncated/);
    expect(() => importPrivateKey('PuTTY-User-Key-File-3: ssh-ed25519\n')).toThrow(/PuTTY/);
  });

  it.skipIf(!hasSshKeygen)('refuses a passphrase-protected key with a clear message (OpenSSH and PEM forms)', () => {
    const p = join(dir, 'enc_key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'secret-pass', '-C', 'x', '-f', p]);
    expect(() => importPrivateKey(readFileSync(p, 'utf8'))).toThrow(/passphrase/);
    const r = join(dir, 'enc_rsa_pem');
    execFileSync('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', 'secret-pass', '-C', 'x', '-f', r]);
    expect(() => importPrivateKey(readFileSync(r, 'utf8'))).toThrow(/passphrase/);
  });

  it.skipIf(!hasSshKeygen)('imports OpenSSH-format RSA and ECDSA keys and derives the same public key as ssh-keygen', () => {
    for (const [type, extra] of [['rsa', ['-b', '2048']], ['ecdsa', ['-b', '256']]] as const) {
      const p = join(dir, `ossh_${type}`);
      execFileSync('ssh-keygen', ['-q', '-t', type, ...extra, '-N', '', '-C', 'c', '-f', p]);
      const k = importPrivateKey(readFileSync(p, 'utf8'), 'c');
      // `ssh-keygen -y` prints the comment for OpenSSH-format keys in some versions only — compare type + blob
      expect(k.publicKey.split(' ').slice(0, 2)).toEqual(keygenPub(p).split(' ').slice(0, 2));
      expect(k.publicKey.endsWith(' c')).toBe(true);
      expect(k.fingerprint).toBe(keygenFp(p));
    }
  });

  it.skipIf(!hasSshKeygen)('imports PEM RSA (PKCS#1) and EC (SEC1) keys and derives the same public key as ssh-keygen', () => {
    for (const [type, extra] of [['rsa', ['-b', '2048']], ['ecdsa', ['-b', '384']]] as const) {
      const p = join(dir, `pem_${type}`);
      execFileSync('ssh-keygen', ['-q', '-t', type, ...extra, '-m', 'PEM', '-N', '', '-C', 'c', '-f', p]);
      const text = readFileSync(p, 'utf8');
      expect(text).toMatch(new RegExp(`-----BEGIN (RSA|EC) ${PK}-----`));
      const k = importPrivateKey(text);
      expect(k.publicKey).toBe(keygenPub(p));
      expect(k.fingerprint).toBe(keygenFp(p));
    }
  });

  it('imports a PKCS#8 ed25519 PEM key (node crypto) and derives its public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const k = importPrivateKey(pem);
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    expect(k.type).toBe('ssh-ed25519');
    expect(parsePublicKeyLine(k.publicKey)!.blob.subarray(-32).equals(raw)).toBe(true);
    expect(() => importPrivateKey(`-----BEGIN ENCRYPTED ${PK}-----\nAAAA\n-----END ENCRYPTED ${PK}-----`)).toThrow(/passphrase/);
  });
});

describe('fingerprintOf / parsePublicKeyLine', () => {
  it('matches the documented GitHub fingerprint of a known key', () => {
    // GitHub's own ed25519 host key (docs.github.com → "GitHub's SSH key fingerprints")
    const line = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
    expect(fingerprintOf(line)).toBe('SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
    expect(parsePublicKeyLine(line)!.type).toBe('ssh-ed25519');
    expect(parsePublicKeyLine('ssh-rsa AAAAC3NzaC1lZDI1NTE5AAAAIOMq')).toBeNull(); // type does not match the blob
    expect(fingerprintOf('garbage')).toBeNull();
  });
});

describe('sshCommand', () => {
  it('pins the key, the per-project known_hosts, accept-new, batch mode and a connect timeout; quotes paths', () => {
    const cmd = sshCommand("/secrets/projects/my proj/id_ed25519", "/secrets/projects/my proj/known_hosts", { connectTimeoutSec: 15 });
    expect(cmd.startsWith("ssh -i '/secrets/projects/my proj/id_ed25519' -o IdentitiesOnly=yes -o UserKnownHostsFile='/secrets/projects/my proj/known_hosts' ")).toBe(true);
    for (const o of ['StrictHostKeyChecking=accept-new', 'BatchMode=yes', 'ConnectTimeout=15', 'HashKnownHosts=no', 'PasswordAuthentication=no']) expect(cmd).toContain(`-o ${o}`);
    expect(cmd).not.toMatch(/[\n;&|]/);
  });
  it('without a key (access "none" on an ssh URL) keeps the pinned hosts and batch mode only', () => {
    const cmd = sshCommand(null, '/kh');
    expect(cmd).not.toContain('-i ');
    expect(cmd).not.toContain('IdentitiesOnly');
    expect(cmd).toContain("UserKnownHostsFile='/kh'");
    expect(cmd).toContain('BatchMode=yes');
  });
  it('shellQuote survives a single quote in a path', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe('known_hosts', () => {
  const content = [
    '# comment',
    'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    '[git.example.org]:2222,10.0.0.5 ssh-rsa AAAAB3',
    '@cert-authority *.corp ssh-rsa AAAAB3',
    '',
  ].join('\n');
  it('lists the pinned hosts (ports stripped, markers skipped) and answers hostIsPinned', () => {
    expect(knownHostsHosts(content)).toEqual(['github.com', 'git.example.org', '10.0.0.5', '*.corp']);
    expect(hostIsPinned(content, 'GitHub.com')).toBe(true);
    expect(hostIsPinned(content, 'git.example.org')).toBe(true);
    expect(hostIsPinned(content, 'gitlab.com')).toBe(false);
    expect(hostIsPinned('', 'github.com')).toBe(false);
  });
  it('treats a hashed file as pinned (cannot tell the host)', () => {
    expect(hostIsPinned('|1|abc=|def= ssh-ed25519 AAAA', 'anything')).toBe(true);
  });
});
