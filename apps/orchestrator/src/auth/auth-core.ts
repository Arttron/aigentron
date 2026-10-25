/**
 * Pure building blocks of the built-in sign-in (one operator password + signed session cookie).
 * No Nest, no I/O — everything here is unit-tested.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

export const SESSION_COOKIE = 'lds_session';
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

export function validatePassword(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'password is required.';
  if (pw.length < MIN_PASSWORD) return `use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > MAX_PASSWORD) return `at most ${MAX_PASSWORD} characters.`;
  return null;
}

/** `scrypt$<salt>$<hash>` (base64) — memory-hard, with a random salt per password. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = scryptSync(pw, Buffer.from(salt, 'base64'), want.length);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface SessionPayload {
  /** Expiry, ms since epoch. */
  exp: number;
  /** Global epoch — bumped by "sign out everywhere" — invalidates every older cookie. */
  epoch: number;
  /** Who is signed in. */
  uid: string;
  /** That user's own epoch — bumped when THEIR password changes or is removed. */
  ue: number;
  /** This session's id (listed in Settings, individually revocable). Absent on cookies issued before sessions were listed. */
  sid?: string;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export function signSession(secret: string, payload: SessionPayload): string {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** The payload when the token is genuine and unexpired (the caller still checks the epochs); otherwise null. */
export function verifySession(secret: string, token: string | undefined, now = Date.now()): SessionPayload | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (typeof p.exp !== 'number' || typeof p.epoch !== 'number' || typeof p.uid !== 'string' || typeof p.ue !== 'number') return null;
    return p.exp > now ? { exp: p.exp, epoch: p.epoch, uid: p.uid, ue: p.ue, ...(typeof p.sid === 'string' && /^[0-9a-f]{16,64}$/.test(p.sid) ? { sid: p.sid } : {}) } : null;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** The session token from the cookie or an `Authorization: Bearer` header (console client). */
export function tokenFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headers.authorization;
  const bearer = (Array.isArray(auth) ? auth[0] : auth)?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer.trim();
  const cookie = headers.cookie;
  return parseCookies(Array.isArray(cookie) ? cookie.join(';') : cookie)[SESSION_COOKIE];
}

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

/**
 * "This machine": loopback, OR one of this host's own interface addresses. The second case matters because the agent
 * hook may call the server by its container/service name (`APPROVALS_API_URL=http://orchestrator:3001`); connecting to
 * your own address makes the source address equal to it. A request relayed by another container or a tunnel arrives
 * from a DIFFERENT address, so it is still refused.
 */
export function isThisMachine(addr: string | undefined, ownAddresses: readonly string[]): boolean {
  if (!addr) return false;
  if (isLoopback(addr)) return true;
  const a = addr.replace(/^::ffff:/, '');
  return ownAddresses.some((o) => o.replace(/^::ffff:/, '') === a);
}

/** Open without a session: liveness and the sign-in endpoints themselves. */
export function isPublicRoute(path: string): boolean {
  // /api/secret-links/<token>: the one-time token is the credential (see SecretLinksService).
  if (path.startsWith('/api/secret-links/')) return true;
  return path === '/api/health' || path === '/api/auth/status' || path === '/api/auth/login' || path === '/api/auth/setup' || path === '/api/auth/logout';
}

/**
 * Routes the agent runtimes / hooks call on the server itself; each has its own credential (hook secret, per-run
 * token). They are exempt from the session check but only when the caller is on the same machine (loopback), so
 * they are not reachable through a public tunnel.
 */
export function isMachineRoute(path: string): boolean {
  return /^\/api\/approvals\/check$/.test(path) || /^\/api\/approvals\/[^/]+\/wait$/.test(path) || path.startsWith('/api/internal-mcp') || path.startsWith('/api/research-mcp');
}

/** Failed sign-ins per key (client address): 5 misses → locked, doubling up to 15 minutes. Old failures are forgotten after an hour. */
export class LoginLimiter {
  private readonly fails = new Map<string, { count: number; until: number; last: number }>();
  constructor(private readonly free = 5) {}

  /** Seconds the caller must wait (0 = may try). */
  wait(key: string, now = Date.now()): number {
    const f = this.fails.get(key);
    return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
  }
  fail(key: string, now = Date.now()): void {
    let f = this.fails.get(key);
    if (!f || now - f.last > 3_600_000) f = { count: 0, until: 0, last: now };
    f.count += 1;
    f.last = now;
    if (f.count >= this.free) f.until = now + Math.min(15 * 60_000, 30_000 * 2 ** (f.count - this.free));
    this.fails.set(key, f);
    if (this.fails.size > 1000) this.fails.delete(this.fails.keys().next().value as string);
  }
  ok(key: string): void {
    this.fails.delete(key);
  }
}

/** `::ffff:10.0.0.5` → `10.0.0.5`, so addresses compare the same however the socket reports them. */
export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). A TCP peer inside them is Cloudflare itself, so its `cf-connecting-ip` is genuine. */
export const CLOUDFLARE_RANGES: readonly string[] = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

/** Does `ip` match one entry of `list` — an exact address or a CIDR (`10.0.0.0/8`, `2606:4700::/32`)? Malformed entries never match. */
export function ipMatches(ip: string, list: readonly string[]): boolean {
  const a = normalizeIp(ip.trim());
  const family = isIP(a);
  if (!family) return false;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  for (const raw of list) {
    const entry = normalizeIp(raw.trim());
    if (!entry) continue;
    try {
      const bl = new BlockList();
      const slash = entry.indexOf('/');
      if (slash === -1) {
        const f = isIP(entry);
        if (!f) continue;
        bl.addAddress(entry, f === 6 ? 'ipv6' : 'ipv4');
      } else {
        const base = entry.slice(0, slash);
        const bits = Number(entry.slice(slash + 1));
        const f = isIP(base);
        if (!f || !Number.isInteger(bits) || bits < 0 || bits > (f === 6 ? 128 : 32)) continue;
        bl.addSubnet(base, bits, f === 6 ? 'ipv6' : 'ipv4');
      }
      if (bl.check(a, type)) return true;
    } catch {
      /* skip a malformed entry */
    }
  }
  return false;
}

/**
 * The address to rate-limit a sign-in by. Behind Cloudflare the real client is in `cf-connecting-ip` — but anyone connecting
 * DIRECTLY could forge that header to get a fresh counter on every try. So the header is believed only when the TCP peer is a proxy
 * we trust: loopback, the `cloudflared` container, TRUSTED_PROXY (exact IPs or CIDRs), or - unless `trustCloudflare` is off - a
 * Cloudflare edge address (orange cloud straight to the host: the peer is always a Cloudflare IP). Otherwise the peer address is the key.
 */
export function clientAddress(cfConnectingIp: string | undefined, peer: string, trustedPeers: readonly string[], trustCloudflare = true): string {
  const p = normalizeIp(peer || 'unknown');
  const trusted = isLoopback(p) || ipMatches(p, trustedPeers) || (trustCloudflare && ipMatches(p, CLOUDFLARE_RANGES));
  const cf = (cfConnectingIp ?? '').trim();
  return trusted && cf && isIP(cf) ? cf : p;
}

/**
 * "This request comes from the machine itself" for the machine-only routes (hook secret, per-run tokens): the socket must be local
 * AND the request must not have been forwarded - with `cloudflared` on the same host every proxied request arrives from loopback,
 * but it carries `cf-connecting-ip` / `x-forwarded-for`, which a local agent process never sets.
 */
export function isDirectLocalRequest(addr: string | undefined, own: readonly string[], headers: Record<string, string | string[] | undefined>): boolean {
  if (!isThisMachine(addr, own)) return false;
  return !headers['cf-connecting-ip'] && !headers['x-forwarded-for'] && !headers['cf-ray'];
}

/** Roles that may manage other people's passwords and settings. */
export const MANAGER_ROLES = ['operator', 'admin'] as const;

/**
 * Removing a password must never leave nobody able to sign in as a manager (operator/admin) — that would lock the
 * instance out of its own settings. `withPassword` = ids that currently have a password.
 */
export function canRemovePassword(users: { id: string; role: string }[], withPassword: ReadonlySet<string>, targetId: string): boolean {
  return users.some((u) => u.id !== targetId && withPassword.has(u.id) && (MANAGER_ROLES as readonly string[]).includes(u.role));
}

/** A readable name for a browser's User-Agent, e.g. "Chrome on macOS" — only for the sign-in list, never for decisions. */
export function describeAgent(ua: string | undefined | null): string {
  const s = ua ?? '';
  if (!s) return 'Unknown device';
  if (/^curl\//i.test(s)) return 'curl';
  if (/^aigentron-cli|^node|undici|node-fetch/i.test(s)) return 'Terminal (aigentron)';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /(Chrome|CriOS)\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : null;
  const os = /Windows/.test(s) ? 'Windows' : /(iPhone|iPad|iPod)/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux|X11/.test(s) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? s.slice(0, 40);
}

// ---- Two-factor sign-in: TOTP (RFC 6238, SHA-1, 6 digits, 30 s — what every authenticator app speaks) + one-time recovery codes ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_S = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/** The 6-digit code of a time step (RFC 4226 on the step counter). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * The time step this code belongs to (±1 step of clock drift), or null. `lastStep` is the newest step already accepted: a code of that step
 * or an older one is refused, so a code seen over a shoulder or in a log cannot be used twice.
 */
export function verifyTotp(secret: string, code: unknown, now = Date.now(), lastStep = 0): number | null {
  if (typeof code !== 'string') return null;
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = Math.floor(now / 1000 / TOTP_STEP_S);
  let hit: number | null = null;
  for (const step of [cur - 1, cur, cur + 1]) {
    const want = Buffer.from(totpCode(secret, step));
    // no early exit: every window is compared, in constant time
    if (timingSafeEqual(want, Buffer.from(c)) && step > lastStep) hit = step;
  }
  return hit;
}

export function otpauthUri(secret: string, account: string, issuer = 'Aigentron'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_S}`;
}

/** Ten one-time codes like `k3f9-x7qm`; only their hashes are stored. */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const b = randomBytes(8);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
export const normaliseRecovery = (c: string): string => c.toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashRecovery = (c: string): string => createHmac('sha256', 'aigentron-recovery').update(normaliseRecovery(c)).digest('base64url');
