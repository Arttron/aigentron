import { createHash, generateKeyPairSync } from 'node:crypto';

/** What a per-server extension is made of — pure functions (no I/O), unit-tested. */

export interface ExtensionKey {
  /** PEM, PKCS#8 — kept in the secrets dir; only the public half goes into the package. */
  privateKeyPem: string;
  /** Base64 of the DER SubjectPublicKeyInfo — what `manifest.json` "key" holds. */
  publicKeyDer: string;
}

export function generateExtensionKey(): ExtensionKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyDer: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** Chrome derives an unpacked extension's ID from the "key": SHA-256 of the DER public key, the first 32 hex digits, each mapped 0-f → a-p. */
export function extensionIdFromKey(publicKeyDer: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKeyDer, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

/** `https://example.com/anything` → `https://example.com`; anything that is not http(s) → null. */
export function originOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** The addresses the extension may talk to / run its page bridge on: the one in use now first, then the others, deduplicated, at most 8. */
export function serverOrigins(candidates: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const o = originOf(c);
    if (o && !out.includes(o)) out.push(o);
  }
  return out.slice(0, 8);
}

/** A Chrome extension version: 1–4 dot-separated integers (0–65535). A release like `0.1.104` fits; anything else becomes `0.0.1`. */
export function extensionVersion(serverVersion: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(serverVersion.trim());
  if (!m) return '0.0.1';
  return [m[1], m[2], m[3]].map((n) => String(Math.min(Number(n), 65535))).join('.');
}

export interface PackageInput {
  /** The shipped manifest.json (a template: name, key, host_permissions and content_scripts[].matches are filled in here). */
  template: Record<string, unknown>;
  serverName: string;
  origins: string[];
  serverVersion: string;
  publicKeyDer: string;
}

/** The manifest of THIS server's extension: its name, its addresses (and nothing broader), its key and its version. */
export function buildManifest(i: PackageInput): Record<string, unknown> {
  if (i.origins.length === 0) throw new Error('no server address to put in the extension');
  const patterns = i.origins.map((o) => `${o}/*`);
  const scripts = Array.isArray(i.template.content_scripts) ? (i.template.content_scripts as Record<string, unknown>[]) : [];
  return {
    ...i.template,
    name: `Aigentron — ${i.serverName}`.slice(0, 45),
    version: extensionVersion(i.serverVersion),
    key: i.publicKeyDer,
    host_permissions: patterns,
    content_scripts: scripts.map((s) => ({ ...s, matches: patterns })),
  };
}

/** What the extension reads at run time (not secret). */
export function buildConfig(i: { serverName: string; origins: string[]; serverVersion: string; extensionId: string }) {
  return { serverName: i.serverName, origins: i.origins, serverVersion: i.serverVersion, extensionId: i.extensionId };
}

/** A short display name of the server: the host of its first address (`example.com`, `localhost:3011`). */
export function serverLabel(origins: string[]): string {
  try {
    return new URL(origins[0] ?? '').host || 'server';
  } catch {
    return 'server';
  }
}
