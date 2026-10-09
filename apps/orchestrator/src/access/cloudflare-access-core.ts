/**
 * Cloudflare Access sign-in check — pure logic (unit-tested). Cloudflare Access puts a signed JWT in the `Cf-Access-Jwt-Assertion`
 * header of every request it lets through; verifying it here means a request that reached this server WITHOUT going through
 * Access (a tunnel hostname without a policy, a direct hit on the origin with the public Host) is refused.
 */
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';

export interface AccessJwk extends JsonWebKey {
  kid?: string;
}

export interface AccessConfig {
  enabled: boolean;
  /** `<team>.cloudflareaccess.com` */
  teamDomain: string;
  /** The Application Audience (AUD) tag of the Access application. */
  aud: string;
}

export type JwtResult = { ok: true; email: string | null; sub: string | null; exp: number } | { ok: false; error: string };

const TEAM_RE = /^[a-z0-9][a-z0-9-]{0,60}\.cloudflareaccess\.com$/;

/** `https://team.cloudflareaccess.com/…` or `team.cloudflareaccess.com` → the bare team domain, or null. */
export function parseTeamDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^https?:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/\/.*$/, '');
  return TEAM_RE.test(s) ? s : null;
}

/** The AUD tag is a 64-char hex string; accept any reasonable token so a format change does not break the setting. */
export function parseAud(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  return /^[A-Za-z0-9._-]{16,200}$/.test(s) ? s : null;
}

const b64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** The `kid` a token was signed with (to pick the key), without verifying anything yet. */
export function tokenKid(token: string): string | null {
  try {
    const h = JSON.parse(b64url(token.split('.')[0] ?? '').toString('utf8')) as { kid?: string };
    return typeof h.kid === 'string' ? h.kid : null;
  } catch {
    return null;
  }
}

/** Verify signature (RS256), issuer, audience and expiry. `now` is in seconds. */
export function verifyAccessJwt(token: string, keys: readonly AccessJwk[], cfg: Pick<AccessConfig, 'teamDomain' | 'aud'>, now = Math.floor(Date.now() / 1000)): JwtResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'not a JWT' };
  let header: { alg?: string; kid?: string };
  let payload: { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string; sub?: string };
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
    payload = JSON.parse(b64url(parts[1]).toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed token' };
  }
  if (header.alg !== 'RS256') return { ok: false, error: 'unexpected algorithm' };
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, error: 'unknown signing key' };
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    if (!verifier.verify(createPublicKey({ key: jwk, format: 'jwk' }), b64url(parts[2]))) return { ok: false, error: 'bad signature' };
  } catch {
    return { ok: false, error: 'bad signature' };
  }
  if (payload.iss !== `https://${cfg.teamDomain}`) return { ok: false, error: 'wrong issuer' };
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(cfg.aud)) return { ok: false, error: 'wrong application (aud)' };
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, error: 'token expired' };
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return { ok: false, error: 'token not valid yet' };
  return { ok: true, email: payload.email ?? null, sub: payload.sub ?? null, exp: payload.exp };
}

/** The token from the headers (Access sets the header; the `CF_Authorization` cookie carries the same JWT). */
export function accessTokenFrom(headers: Record<string, string | string[] | undefined>): string | null {
  const h = headers['cf-access-jwt-assertion'];
  const v = Array.isArray(h) ? h[0] : h;
  if (v) return v.trim();
  const cookie = headers.cookie;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(Array.isArray(cookie) ? cookie.join(';') : (cookie ?? ''));
  return m ? decodeURIComponent(m[1]) : null;
}
