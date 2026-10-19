/**
 * A project's repository secrets as FILES under `<secrets dir>/projects/<slug>/` (the owner's decision: tokens leave
 * the database). The directory is 0700, every file 0600, writes are atomic (tmp + chmod + rename) — the same
 * conventions as auth.json (security/secret-json-file.ts). With agent isolation on, `secrets/` is closed to the
 * agent user by infra/harden.sh, so only the orchestrator ever reads these files.
 *
 *   token            one line — the https token (GitHub PAT / fine-grained token, GitLab project token, Bitbucket app password)
 *   id_ed25519       the private key, OpenSSH format (whatever the type — the name is the conventional one)
 *   id_ed25519.pub   its public key line (what the person pastes as a deploy key)
 *   known_hosts      the host key(s) pinned on first use — per project, so one repo's host cannot vouch for another's
 *   last-test.json   the last connection test (no secrets in it — the report is redacted before it is stored)
 *
 * Nothing here logs a value. Slugs are validated against the project slug alphabet before they touch a path.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isValidSlug } from '../project-core';
import { fingerprintOf } from './ssh-keys';

export const PROJECT_SECRET_FILES = {
  token: 'token',
  privateKey: 'id_ed25519',
  publicKey: 'id_ed25519.pub',
  knownHosts: 'known_hosts',
  lastTest: 'last-test.json',
} as const;

export interface StoredSshKey {
  privateKeyPath: string;
  publicKey: string;
  fingerprint: string | null;
}

/** The last connection test, as stored (already redacted — see RepoTestReport). */
export interface StoredLastTest {
  at: string;
  ok: boolean;
  summary: string;
  durationMs: number;
}

const MAX_TOKEN = 4000;

export class ProjectSecretsStore {
  readonly root: string;

  constructor(secretsDir: string) {
    this.root = join(secretsDir, 'projects');
  }

  /** `<secrets>/projects/<slug>` — only for a valid slug (path safety), never created here. */
  dirOf(slug: string): string {
    if (!isValidSlug(slug)) throw new Error(`invalid project slug "${slug}"`);
    const dir = resolve(this.root, slug);
    if (!dir.startsWith(resolve(this.root) + sep)) throw new Error(`invalid project slug "${slug}"`);
    return dir;
  }

  pathOf(slug: string, file: keyof typeof PROJECT_SECRET_FILES): string {
    return join(this.dirOf(slug), PROJECT_SECRET_FILES[file]);
  }

  /** Create the project's directory (0700, and re-assert the mode when it already exists). */
  ensureDir(slug: string): string {
    const dir = this.dirOf(slug);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
  }

  // ---- token ----------------------------------------------------------------------------------------------

  hasToken(slug: string): boolean {
    return existsSync(this.pathOf(slug, 'token'));
  }

  /** The token (first line, trimmed) or null. */
  readToken(slug: string): string | null {
    const t = readOrNull(this.pathOf(slug, 'token'));
    const line = t?.split('\n')[0]?.trim();
    return line || null;
  }

  /** The last 4 characters for the UI (`…abcd`), or null. */
  tokenHint(slug: string): string | null {
    const t = this.readToken(slug);
    return t ? `…${t.slice(-4)}` : null;
  }

  writeToken(slug: string, token: string): void {
    const t = (token ?? '').trim();
    if (!t) throw new Error('the token is empty');
    if (t.length > MAX_TOKEN) throw new Error('the token is too long to be a token');
    if (/[\s]/.test(t)) throw new Error('a token has no spaces or line breaks');
    this.ensureDir(slug);
    atomicWrite(this.pathOf(slug, 'token'), `${t}\n`);
  }

  clearToken(slug: string): void {
    rmSync(this.pathOf(slug, 'token'), { force: true });
  }

  // ---- ssh key --------------------------------------------------------------------------------------------

  hasSshKey(slug: string): boolean {
    return existsSync(this.pathOf(slug, 'privateKey'));
  }

  /** The stored key's public side (the private key is never read back into memory by callers — ssh reads the file). */
  readSshKey(slug: string): StoredSshKey | null {
    const privateKeyPath = this.pathOf(slug, 'privateKey');
    if (!existsSync(privateKeyPath)) return null;
    const publicKey = (readOrNull(this.pathOf(slug, 'publicKey')) ?? '').trim();
    return { privateKeyPath, publicKey, fingerprint: publicKey ? fingerprintOf(publicKey) : null };
  }

  writeSshKey(slug: string, key: { privateKey: string; publicKey: string }): void {
    this.ensureDir(slug);
    atomicWrite(this.pathOf(slug, 'privateKey'), key.privateKey.endsWith('\n') ? key.privateKey : `${key.privateKey}\n`);
    atomicWrite(this.pathOf(slug, 'publicKey'), `${key.publicKey.trim()}\n`);
  }

  clearSshKey(slug: string): void {
    rmSync(this.pathOf(slug, 'privateKey'), { force: true });
    rmSync(this.pathOf(slug, 'publicKey'), { force: true });
  }

  // ---- known_hosts ----------------------------------------------------------------------------------------

  /** The path ssh writes to on first use (the file need not exist yet; the directory must). */
  knownHostsPath(slug: string): string {
    this.ensureDir(slug);
    const p = this.pathOf(slug, 'knownHosts');
    if (!existsSync(p)) atomicWrite(p, '');
    return p;
  }

  readKnownHosts(slug: string): string {
    return readOrNull(this.pathOf(slug, 'knownHosts')) ?? '';
  }

  clearKnownHosts(slug: string): void {
    rmSync(this.pathOf(slug, 'knownHosts'), { force: true });
  }

  // ---- last test ------------------------------------------------------------------------------------------

  readLastTest(slug: string): StoredLastTest | null {
    const raw = readOrNull(this.pathOf(slug, 'lastTest'));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Partial<StoredLastTest>;
      return typeof v.at === 'string' && typeof v.ok === 'boolean' ? { at: v.at, ok: v.ok, summary: String(v.summary ?? ''), durationMs: Number(v.durationMs ?? 0) } : null;
    } catch {
      return null;
    }
  }

  writeLastTest(slug: string, t: StoredLastTest): void {
    this.ensureDir(slug);
    atomicWrite(this.pathOf(slug, 'lastTest'), JSON.stringify(t));
  }

  clearLastTest(slug: string): void {
    rmSync(this.pathOf(slug, 'lastTest'), { force: true });
  }

  // ---- all ------------------------------------------------------------------------------------------------

  /** Remove every secret of the project (token, key, pinned hosts, last test) and its directory. */
  clearAll(slug: string): void {
    rmSync(this.dirOf(slug), { recursive: true, force: true });
  }

  /** The modes of what exists (for a self-check / tests). */
  modes(slug: string): Record<string, number> {
    const out: Record<string, number> = {};
    const dir = this.dirOf(slug);
    if (existsSync(dir)) out['.'] = statSync(dir).mode & 0o777;
    for (const f of Object.values(PROJECT_SECRET_FILES)) {
      const p = join(dir, f);
      if (existsSync(p)) out[f] = statSync(p).mode & 0o777;
    }
    return out;
  }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** tmp (0600) → chmod → rename: a reader sees the old file or the new one, never a partial write. */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
