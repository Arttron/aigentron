import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A browser extension's own credential — NOT a sign-in session. It identifies one installed extension to this server, independent of whether a
 * password is set, of 2FA, of password changes: pairing (a one-use code the dashboard hands over) creates a device record, and its token is
 * `ext_<id>_<secret>`. The server keeps only a hash of the secret. Revoked by removing the record (Add-ons → Extension).
 */
export interface DeviceRecord {
  id: string;
  /** sha256 (hex) of the secret part */
  hash: string;
  /** the user it acts as: the signed-in person who paired it, or the default operator when the server has no sign-in */
  userId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  /** the extension's own version, as it last reported it (an `x-extension-version` header / the socket's connect packet) */
  version?: string;
  /** whether Chrome has given the extension access to websites (agents cannot use the browser without it); as last reported */
  allSites?: boolean;
}

export const TOKEN_RE = /^ext_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
/** A device not heard from for this long stops working (sliding: every call renews it). */
export const DEVICE_IDLE_DAYS = 180;

const hashOf = (secret: string): string => createHash('sha256').update(secret).digest('hex');

export function newDevice(userId: string, label: string, now = new Date()): { record: DeviceRecord; token: string } {
  const id = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return {
    token: `ext_${id}_${secret}`,
    record: { id, hash: hashOf(secret), userId, label: label.replace(/[()]/g, '').trim().slice(0, 60) || 'Chromium', createdAt: now.toISOString(), lastSeenAt: now.toISOString() },
  };
}

/** Is the string shaped like an extension token (so the guard knows which check applies)? */
export const looksLikeDeviceToken = (t: string | undefined): t is string => typeof t === 'string' && t.startsWith('ext_');

/** The device a token belongs to — or null (unknown, wrong secret, idle for too long). */
export function verifyDevice(devices: readonly DeviceRecord[], token: string | undefined, now = Date.now()): DeviceRecord | null {
  const m = typeof token === 'string' ? TOKEN_RE.exec(token) : null;
  if (!m) return null;
  const d = devices.find((x) => x.id === m[1]);
  if (!d) return null;
  const want = Buffer.from(d.hash, 'hex');
  const got = Buffer.from(hashOf(m[2]!), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return now - Date.parse(d.lastSeenAt) > DEVICE_IDLE_DAYS * 86_400_000 ? null : d;
}
