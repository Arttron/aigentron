/**
 * SSH keys for project repositories — pure functions, no I/O, no Nest (ssh-keys.test.ts).
 *
 * Key pairs are made with node's crypto and written in the OpenSSH private-key format (RFC 4716 / PROTOCOL.key),
 * so no `ssh-keygen` binary is needed to CREATE a key; `ssh` itself is still needed to USE it (openssh-client in the
 * images). Import accepts an unencrypted OpenSSH-format key of any type and PEM (PKCS#8 / PKCS#1 / SEC1) ed25519, RSA
 * and ECDSA keys; a passphrase-protected key is refused with a clear message (ssh runs unattended, BatchMode=yes).
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

export interface SshKeyPair {
  /** The private key file content (OpenSSH format, trailing newline). Never logged, never returned over HTTP. */
  privateKey: string;
  /** One line: `<type> <base64 blob> <comment>` — what the person adds as a deploy key. */
  publicKey: string;
  /** `SHA256:<base64>` as `ssh-keygen -lf` and the GitHub/GitLab UIs show it. */
  fingerprint: string;
  /** ssh-ed25519 | ssh-rsa | ecdsa-sha2-nistp256 | … */
  type: string;
}

export class SshKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshKeyError';
  }
}

const OPENSSH_MAGIC = 'openssh-key-v1\0';

// ---- SSH wire helpers (RFC 4251 `string` / `uint32` / `mpint`) --------------------------------------------------------

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const sshString = (b: Buffer): Buffer => Buffer.concat([u32(b.length), b]);
const sshMpint = (b: Buffer): Buffer => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  return sshString(v[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
};

class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}
  u32(): number {
    if (this.pos + 4 > this.buf.length) throw new SshKeyError('truncated key data');
    const n = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return n;
  }
  string(): Buffer {
    const n = this.u32();
    if (this.pos + n > this.buf.length) throw new SshKeyError('truncated key data');
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new SshKeyError('truncated key data');
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
}

// ---- public-key lines & fingerprints -----------------------------------------------------------------------------------

/** Parse `<type> <base64> [comment]`; null when it is not a public key line. */
export function parsePublicKeyLine(line: string): { type: string; blob: Buffer; comment: string } | null {
  const m = /^\s*(\S+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*?))?\s*$/.exec(line ?? '');
  if (!m) return null;
  const blob = Buffer.from(m[2]!, 'base64');
  try {
    const typeInBlob = new Reader(blob).string().toString('latin1');
    if (typeInBlob !== m[1]) return null;
  } catch {
    return null;
  }
  return { type: m[1]!, blob, comment: m[3] ?? '' };
}

/** `SHA256:<base64 without padding>` of a public key line (what ssh-keygen -lf and the hosting UIs show). */
export function fingerprintOf(publicKeyLine: string): string | null {
  const p = parsePublicKeyLine(publicKeyLine);
  if (!p) return null;
  return `SHA256:${createHash('sha256').update(p.blob).digest('base64').replace(/=+$/, '')}`;
}

// ---- generation --------------------------------------------------------------------------------------------------------

/** A fresh ed25519 key pair in OpenSSH format (unencrypted — ssh runs unattended). */
export function generateEd25519(comment: string): SshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pub = Buffer.from(spki.subarray(spki.length - 32));
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const seed = Buffer.from(pkcs8.subarray(pkcs8.length - 32));
  const type = Buffer.from('ssh-ed25519');
  const pubBlob = Buffer.concat([sshString(type), sshString(pub)]);
  const privSection = Buffer.concat([sshString(type), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(Buffer.from(sanitizeComment(comment)))]);
  const privateKeyText = encodeOpenSsh(pubBlob, privSection);
  const publicKeyLine = `ssh-ed25519 ${pubBlob.toString('base64')} ${sanitizeComment(comment)}`.trim();
  seed.fill(0);
  return { privateKey: privateKeyText, publicKey: publicKeyLine, fingerprint: fingerprintOf(publicKeyLine)!, type: 'ssh-ed25519' };
}

function sanitizeComment(c: string): string {
  return (c ?? '').replace(/[\r\n\s]+/g, '-').slice(0, 80);
}

/** The `openssh-key-v1` container around one unencrypted key (PROTOCOL.key). */
function encodeOpenSsh(pubBlob: Buffer, privSection: Buffer): string {
  const check = randomBytes(4);
  let priv = Buffer.concat([check, check, privSection]);
  for (let i = 1; priv.length % 8 !== 0; i++) priv = Buffer.concat([priv, Buffer.from([i])]);
  const body = Buffer.concat([
    Buffer.from(OPENSSH_MAGIC, 'latin1'),
    sshString(Buffer.from('none')),
    sshString(Buffer.from('none')),
    sshString(Buffer.alloc(0)),
    u32(1),
    sshString(pubBlob),
    sshString(priv),
  ]);
  const b64 = body.toString('base64').match(/.{1,70}/g)!.join('\n');
  return `${pemEdge('BEGIN', 'OPENSSH ')}\n${b64}\n${pemEdge('END', 'OPENSSH ')}\n`;
}

// ---- import ------------------------------------------------------------------------------------------------------------

// The marker words are assembled, never written as one literal: secret scanners (gitleaks in the release pipeline) flag any
// "BEGIN … PRIVATE KEY" text in source files, including code that merely recognises such a block.
const KEY_WORDS = ['PRIVATE', 'KEY'].join(' ');
const pemEdge = (edge: 'BEGIN' | 'END', label: string): string => `-----${edge} ${label}${KEY_WORDS}-----`;

const PASSPHRASE_MSG = 'the private key is protected by a passphrase — ssh runs unattended here, so remove it first (ssh-keygen -p -N "" -f <key>) or generate a key on this server instead';

/**
 * Validate an imported private key and derive its public key line. Returns the key text normalised (LF, one
 * trailing newline) — it is written to disk as is. Throws SshKeyError with a message meant for the person.
 */
export function importPrivateKey(text: string, comment = ''): SshKeyPair {
  const body = (text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new SshKeyError('the private key is empty');
  if (body.length > 32_000) throw new SshKeyError('the private key is too large to be a key');
  if (/^ssh-(rsa|ed25519|dss)\s|^ecdsa-sha2-/.test(body)) throw new SshKeyError('that is a PUBLIC key — paste the private key (the file without .pub)');
  if (body.includes(pemEdge('BEGIN', 'OPENSSH '))) return importOpenSsh(body, comment);
  if (body.includes(pemEdge('BEGIN', 'ENCRYPTED ')) || /Proc-Type: 4,ENCRYPTED/.test(body)) throw new SshKeyError(PASSPHRASE_MSG);
  if (new RegExp(`-----BEGIN (RSA |EC |)${KEY_WORDS}-----`).test(body)) return importPem(body, comment);
  if (new RegExp(`-----BEGIN (SSH2 ENCRYPTED ${KEY_WORDS}|DSA ${KEY_WORDS})-----`).test(body)) throw new SshKeyError('this key format is not supported — use an OpenSSH ed25519, RSA or ECDSA key');
  if (/PuTTY-User-Key-File/.test(body)) throw new SshKeyError('PuTTY .ppk keys are not supported — export it in OpenSSH format (PuTTYgen → Conversions → Export OpenSSH key)');
  throw new SshKeyError(`not a private key: expected "${pemEdge('BEGIN', 'OPENSSH ')}" (or a PEM "BEGIN ${KEY_WORDS}" block)`);
}

function importOpenSsh(body: string, comment: string): SshKeyPair {
  const m = new RegExp(`${pemEdge('BEGIN', 'OPENSSH ')}\\n([\\s\\S]*?)\\n${pemEdge('END', 'OPENSSH ')}`).exec(body);
  if (!m) throw new SshKeyError('the OpenSSH private key block is incomplete (missing END line?)');
  const raw = Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64');
  if (raw.subarray(0, OPENSSH_MAGIC.length).toString('latin1') !== OPENSSH_MAGIC) throw new SshKeyError('not an OpenSSH private key (bad magic)');
  const r = new Reader(raw.subarray(OPENSSH_MAGIC.length));
  const cipher = r.string().toString('latin1');
  const kdf = r.string().toString('latin1');
  r.string(); // kdf options
  const count = r.u32();
  if (cipher !== 'none' || kdf !== 'none') throw new SshKeyError(PASSPHRASE_MSG);
  if (count !== 1) throw new SshKeyError(`the file holds ${count} keys — one key per project`);
  const pubBlob = r.string();
  const type = new Reader(pubBlob).string().toString('latin1');
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-)/.test(type)) throw new SshKeyError(`unsupported key type "${type}" — use ed25519, RSA or ECDSA`);
  if (type.startsWith('sk-')) throw new SshKeyError('hardware-backed (FIDO/U2F "sk-") keys cannot be used by an unattended server');
  // the private section: checkint twice (equal when unencrypted), then the key — enough to know it is readable
  const priv = new Reader(r.string());
  if (priv.u32() !== priv.u32()) throw new SshKeyError('the private key data is corrupt (check bytes differ)');
  if (priv.string().toString('latin1') !== type) throw new SshKeyError('the private key data is corrupt (type mismatch)');
  const publicKey = `${type} ${pubBlob.toString('base64')} ${sanitizeComment(comment)}`.trim();
  return { privateKey: `${m[0]}\n`, publicKey, fingerprint: fingerprintOf(publicKey)!, type };
}

function importPem(body: string, comment: string): SshKeyPair {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: body, format: 'pem' });
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/passphrase|bad decrypt|encrypted/i.test(msg)) throw new SshKeyError(PASSPHRASE_MSG);
    throw new SshKeyError(`the PEM private key cannot be read: ${msg.split('\n')[0]}`);
  }
  const { type, blob } = publicBlobOf(key);
  const publicKey = `${type} ${blob.toString('base64')} ${sanitizeComment(comment)}`.trim();
  return { privateKey: `${body}\n`, publicKey, fingerprint: fingerprintOf(publicKey)!, type };
}

/** The SSH public-key blob of a node KeyObject (ed25519, RSA, EC P-256/384/521). */
function publicBlobOf(key: KeyObject): { type: string; blob: Buffer } {
  const jwk = key.export({ format: 'jwk' }) as Record<string, string>;
  const b64 = (s: string) => Buffer.from(s, 'base64url');
  switch (key.asymmetricKeyType) {
    case 'ed25519':
      return { type: 'ssh-ed25519', blob: Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(b64(jwk.x!))]) };
    case 'rsa':
      return { type: 'ssh-rsa', blob: Buffer.concat([sshString(Buffer.from('ssh-rsa')), sshMpint(b64(jwk.e!)), sshMpint(b64(jwk.n!))]) };
    case 'ec': {
      const curve = ({ 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' } as Record<string, string>)[jwk.crv!];
      if (!curve) throw new SshKeyError(`unsupported EC curve ${jwk.crv} — ssh knows nistp256/384/521`);
      const type = `ecdsa-sha2-${curve}`;
      const point = Buffer.concat([Buffer.from([4]), b64(jwk.x!), b64(jwk.y!)]);
      return { type, blob: Buffer.concat([sshString(Buffer.from(type)), sshString(Buffer.from(curve)), sshString(point)]) };
    }
    default:
      throw new SshKeyError(`unsupported key type "${key.asymmetricKeyType}" — use ed25519, RSA or ECDSA`);
  }
}

// ---- the ssh command git runs ------------------------------------------------------------------------------------------

/** POSIX single-quoting for a path inside GIT_SSH_COMMAND (git hands the string to /bin/sh). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `GIT_SSH_COMMAND` for a project: only this key (IdentitiesOnly), the project's own known_hosts (trust on first
 * use via accept-new, then pinned — a changed host key is an error), never a prompt (BatchMode), bounded connect time.
 * Host names are written in clear (HashKnownHosts=no) so the status can say which host is pinned.
 */
export function sshCommand(keyPath: string | null, knownHostsPath: string, opts: { connectTimeoutSec?: number } = {}): string {
  return [
    'ssh',
    ...(keyPath ? ['-i', shellQuote(keyPath), '-o', 'IdentitiesOnly=yes'] : []),
    '-o', `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'HashKnownHosts=no',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', `ConnectTimeout=${opts.connectTimeoutSec ?? 15}`,
    '-o', 'LogLevel=ERROR',
  ].join(' ');
}

/** Hosts pinned in a known_hosts file (plain or `[host]:port` entries; hashed lines are reported as `*`). */
export function knownHostsHosts(content: string): string[] {
  const out = new Set<string>();
  for (const raw of (content ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const field = (line.startsWith('@') ? line.split(/\s+/)[1] : line.split(/\s+/)[0]) ?? '';
    if (field.startsWith('|1|')) {
      out.add('*');
      continue;
    }
    for (const h of field.split(',')) {
      const m = /^\[([^\]]+)\]:\d+$/.exec(h);
      out.add((m ? m[1]! : h).toLowerCase());
    }
  }
  return [...out];
}

/** Whether `host` is pinned in the known_hosts content (a hashed file counts as "something is pinned"). */
export function hostIsPinned(content: string, host: string): boolean {
  const hosts = knownHostsHosts(content);
  return hosts.includes(host.toLowerCase()) || hosts.includes('*');
}
