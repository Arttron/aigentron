import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A local agent's own credential (the Go daemon on a person's machine) — like a browser extension's device token, NOT a sign-in session:
 * `lag_<id>_<secret>`, only a hash of the secret is kept. Revoked by removing the record (Add-ons → Local agent).
 */
export interface LocalDevice {
  id: string;
  hash: string;
  /** the user it acts as: the signed-in person who approved it, or the default operator when the server has no sign-in */
  userId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  version?: string;
  os?: string;
  arch?: string;
  host?: string;
}

export const LOCAL_TOKEN_RE = /^lag_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
/** A device not heard from for this long stops working (sliding: every connection renews it). */
export const LOCAL_DEVICE_IDLE_DAYS = 180;

const hashOf = (secret: string): string => createHash('sha256').update(secret).digest('hex');
/** Drop control characters (and the parentheses a label must not carry), trim, cut. */
export const stripControl = (s: unknown, max: number, extra = ''): string =>
  typeof s === 'string' ? [...s].filter((c) => c.charCodeAt(0) >= 32 && !extra.includes(c)).join('').trim().slice(0, max) : '';
const clean = (s: unknown, max: number): string => stripControl(s, max, '()');

export function newLocalDevice(userId: string, label: string, meta: { os?: unknown; arch?: unknown; host?: unknown; version?: unknown } = {}, now = new Date()): { record: LocalDevice; token: string } {
  const id = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const record: LocalDevice = { id, hash: hashOf(secret), userId, label: clean(label, 60) || 'Computer', createdAt: now.toISOString(), lastSeenAt: now.toISOString() };
  for (const k of ['os', 'arch', 'host', 'version'] as const) {
    const v = clean(meta[k], 60);
    if (v) record[k] = v;
  }
  return { token: `lag_${id}_${secret}`, record };
}

export const looksLikeLocalToken = (t: string | undefined): t is string => typeof t === 'string' && t.startsWith('lag_');

export function verifyLocalDevice(devices: readonly LocalDevice[], token: string | undefined, now = Date.now()): LocalDevice | null {
  const m = typeof token === 'string' ? LOCAL_TOKEN_RE.exec(token) : null;
  if (!m) return null;
  const d = devices.find((x) => x.id === m[1]);
  if (!d) return null;
  const want = Buffer.from(d.hash, 'hex');
  const got = Buffer.from(hashOf(m[2]!), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return now - Date.parse(d.lastSeenAt) > LOCAL_DEVICE_IDLE_DAYS * 86_400_000 ? null : d;
}
