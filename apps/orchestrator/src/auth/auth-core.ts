/**
 * Pure building blocks of the built-in sign-in (one operator password + signed session cookie).
 * No Nest, no I/O — everything here is unit-tested.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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
    return p.exp > now ? { exp: p.exp, epoch: p.epoch, uid: p.uid, ue: p.ue } : null;
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

/** Failed sign-ins per key (client address): 5 misses → locked, doubling up to 15 minutes. */
export class LoginLimiter {
  private readonly fails = new Map<string, { count: number; until: number }>();
  constructor(private readonly free = 5) {}

  /** Seconds the caller must wait (0 = may try). */
  wait(key: string, now = Date.now()): number {
    const f = this.fails.get(key);
    return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
  }
  fail(key: string, now = Date.now()): void {
    const f = this.fails.get(key) ?? { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= this.free) f.until = now + Math.min(15 * 60_000, 30_000 * 2 ** (f.count - this.free));
    this.fails.set(key, f);
    if (this.fails.size > 1000) this.fails.delete(this.fails.keys().next().value as string);
  }
  ok(key: string): void {
    this.fails.delete(key);
  }
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
