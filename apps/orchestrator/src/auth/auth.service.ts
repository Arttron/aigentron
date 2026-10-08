import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { publicOrigin } from '../config/cors';
import { UsersService } from '../users/users.service';
import {
  LoginLimiter,
  canRemovePassword,
  hashPassword,
  signSession,
  tokenFromRequest,
  validatePassword,
  verifyPassword,
  verifySession,
} from './auth-core';

interface UserCred {
  hash: string;
  /** Bumped when this user's password changes or is removed — signs that user out everywhere. */
  epoch: number;
}
interface AuthState {
  /** HMAC key for session cookies. */
  secret: string;
  /** Global epoch ("sign out everyone"). */
  epoch: number;
  users: Record<string, UserCred>;
  /** Pre-multi-user file: one password for the default operator. Migrated at startup. */
  passwordHash?: string;
}

export interface LoginUser {
  id: string;
  displayName: string;
  role: string;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status?: number };

/**
 * Built-in sign-in: each user has their own password. Hashes and the session-signing key live in
 * `<secretsDir>/auth.json` (mode 0600) — the credentials directory the approval gate already guards, outside the agent
 * tree, no database migration. Deleting that file turns sign-in off (see `make reset-password`).
 *
 * Until a first password exists the instance behaves as before (open). The first password belongs to the default operator.
 */
@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger('Auth');
  private readonly limiter = new LoginLimiter();
  private cache: { mtime: number; state: AuthState | null } = { mtime: -1, state: null };

  constructor(
    private readonly config: AppConfigService,
    private readonly users: UsersService,
  ) {}

  private get file(): string {
    return join(this.config.secretsDir, 'auth.json');
  }

  /** Current state, re-read when the file changed (e.g. removed by `make reset-password`). */
  private state(): AuthState | null {
    let mtime = 0;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      this.cache = { mtime: 0, state: null };
      return null;
    }
    if (mtime !== this.cache.mtime) {
      try {
        const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AuthState>;
        this.cache = {
          mtime,
          state:
            s.secret && Number.isFinite(s.epoch)
              ? { secret: s.secret, epoch: s.epoch!, users: s.users && typeof s.users === 'object' ? s.users : {}, passwordHash: s.passwordHash }
              : null,
        };
      } catch {
        this.cache = { mtime, state: null };
      }
    }
    return this.cache.state;
  }

  private write(s: AuthState): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.cache = { mtime: -1, state: null }; // force a re-read
  }

  private fresh(): AuthState {
    return { secret: randomBytes(32).toString('base64url'), epoch: 1, users: {} };
  }

  async onModuleInit(): Promise<void> {
    // Migrate the single-password file of the previous version: that password belongs to the default operator.
    const s = this.state();
    if (s?.passwordHash) {
      const op = await this.users.defaultOperator();
      const { passwordHash, ...rest } = s;
      this.write({ ...rest, users: { ...rest.users, [op.id]: { hash: passwordHash, epoch: 1 } } });
      this.logger.log(`Migrated the sign-in password to the user "${op.displayName}".`);
    }
    const initial = process.env.ADMIN_PASSWORD;
    if (!this.isConfigured() && initial && !validatePassword(initial)) {
      const op = await this.users.defaultOperator();
      const st = this.fresh();
      st.users[op.id] = { hash: hashPassword(initial), epoch: 1 };
      this.write(st);
      this.logger.log(`Sign-in password for "${op.displayName}" set from ADMIN_PASSWORD (you can remove it from the environment now).`);
    }
    if (!this.isConfigured()) {
      const pub = publicOrigin(process.env.PUBLIC_URL);
      this.logger.warn(
        `No sign-in password is set — the API is open to anyone who can reach it${pub ? ` (PUBLIC_URL=${pub}!)` : ''}. ` +
          'Set one in the dashboard (Settings → General → Security) or with ADMIN_PASSWORD.',
      );
    }
  }

  isConfigured(): boolean {
    const s = this.state();
    return !!s && (Object.keys(s.users).length > 0 || !!s.passwordHash);
  }

  /** The signed-in user's id for this request, or null. */
  sessionUserId(headers: Record<string, string | string[] | undefined>): string | null {
    const s = this.state();
    if (!s) return null;
    const p = verifySession(s.secret, tokenFromRequest(headers));
    if (!p || p.epoch !== s.epoch) return null;
    return s.users[p.uid]?.epoch === p.ue ? p.uid : null;
  }

  hasSession(headers: Record<string, string | string[] | undefined>): boolean {
    return this.sessionUserId(headers) !== null;
  }

  /** True when sign-in is off, or this request carries a valid session. */
  isAuthenticated(headers: Record<string, string | string[] | undefined>): boolean {
    return !this.isConfigured() || this.hasSession(headers);
  }

  sessionDays(): number {
    const d = Number.parseInt(process.env.AUTH_SESSION_DAYS ?? '30', 10);
    return Number.isFinite(d) && d > 0 ? Math.min(d, 365) : 30;
  }

  private issue(s: AuthState, uid: string): string {
    return signSession(s.secret, { exp: Date.now() + this.sessionDays() * 86_400_000, epoch: s.epoch, uid, ue: s.users[uid]!.epoch });
  }

  /** Users who can sign in (have a password) — what the login screen lists. */
  async loginUsers(): Promise<LoginUser[]> {
    const s = this.state();
    if (!s) return [];
    const all = await this.users.list();
    return all.filter((u) => s.users[u.id]).map((u) => ({ id: u.id, displayName: u.displayName, role: u.role }));
  }

  async userById(id: string): Promise<LoginUser | null> {
    const u = await this.users.getRow(id).catch(() => null);
    return u ? { id: u.id, displayName: u.displayName, role: u.role } : null;
  }

  /** Every user plus whether they have a password (for the Users tab; managers only). */
  async passwordOverview(): Promise<{ id: string; hasPassword: boolean }[]> {
    const s = this.state();
    return (await this.users.list()).map((u) => ({ id: u.id, hasPassword: !!s?.users[u.id] }));
  }

  /** First password ever: belongs to the default operator. Only while sign-in is off. */
  async setup(password: unknown): Promise<Result<{ token: string; uid: string }>> {
    if (this.isConfigured()) return { ok: false, error: 'A password is already set.' };
    const bad = validatePassword(password);
    if (bad) return { ok: false, error: bad };
    const op = await this.users.defaultOperator();
    const s = this.fresh();
    s.users[op.id] = { hash: hashPassword(password as string), epoch: 1 };
    this.write(s);
    return { ok: true, token: this.issue(s, op.id), uid: op.id };
  }

  /** `user` is an id or (for scripts) a display name; omitted = the only user who has a password. */
  async login(user: unknown, password: unknown, key: string): Promise<Result<{ token: string; uid: string }>> {
    const s = this.state();
    if (!s) return { ok: false, error: 'No password is set.' };
    const wait = this.limiter.wait(key);
    if (wait > 0) return { ok: false, error: `Too many attempts — try again in ${wait}s.`, status: 429 };
    const candidates = await this.loginUsers();
    let u: LoginUser | undefined;
    if (typeof user === 'string' && user) {
      u = candidates.find((c) => c.id === user) ?? candidates.find((c) => c.displayName.toLowerCase() === user.toLowerCase());
    } else if (candidates.length === 1) {
      u = candidates[0];
    } else {
      return { ok: false, error: 'Choose who is signing in.' };
    }
    const cred = u && s.users[u.id];
    // Same work and same message whether the user or the password is wrong.
    if (!u || !cred || typeof password !== 'string' || !verifyPassword(password, cred.hash)) {
      this.limiter.fail(key);
      return { ok: false, error: 'Wrong password.', status: 401 };
    }
    this.limiter.ok(key);
    return { ok: true, token: this.issue(s, u.id), uid: u.id };
  }

  /** Change your own password (needs the current one). Signs your other browsers out. */
  async changeOwnPassword(uid: string, current: unknown, next: unknown, key: string): Promise<Result<{ token: string }>> {
    const s = this.state();
    const cred = s?.users[uid];
    if (!s || !cred) return { ok: false, error: 'No password is set for you.' };
    const wait = this.limiter.wait(key);
    if (wait > 0) return { ok: false, error: `Too many attempts — try again in ${wait}s.`, status: 429 };
    if (typeof current !== 'string' || !verifyPassword(current, cred.hash)) {
      this.limiter.fail(key);
      return { ok: false, error: 'The current password is wrong.' };
    }
    const bad = validatePassword(next);
    if (bad) return { ok: false, error: bad };
    s.users[uid] = { hash: hashPassword(next as string), epoch: cred.epoch + 1 };
    this.write(s);
    return { ok: true, token: this.issue(s, uid) };
  }

  /** A manager sets (or resets) someone's password. That user is signed out everywhere. */
  async setUserPassword(targetId: string, password: unknown): Promise<Result<object>> {
    const s = this.state();
    if (!s) return { ok: false, error: 'Set the first password in Security before adding others.' };
    if (!(await this.userById(targetId))) return { ok: false, error: 'No such user.', status: 404 };
    const bad = validatePassword(password);
    if (bad) return { ok: false, error: bad };
    s.users[targetId] = { hash: hashPassword(password as string), epoch: (s.users[targetId]?.epoch ?? 0) + 1 };
    this.write(s);
    return { ok: true };
  }

  /** A manager removes someone's password (they can no longer sign in). Never the last manager's. */
  async removeUserPassword(targetId: string): Promise<Result<object>> {
    const s = this.state();
    if (!s?.users[targetId]) return { ok: false, error: 'That user has no password.', status: 404 };
    const all = await this.users.list();
    if (!canRemovePassword(all, new Set(Object.keys(s.users)), targetId)) {
      return { ok: false, error: 'Someone with the operator or admin role must keep a password — set another first.' };
    }
    delete s.users[targetId];
    this.write(s);
    return { ok: true };
  }

  /** Sign everyone else out; keep the caller signed in. */
  signOutEverywhere(uid: string): { token: string } | null {
    const s = this.state();
    if (!s?.users[uid]) return null;
    s.secret = randomBytes(32).toString('base64url');
    s.epoch += 1;
    this.write(s);
    return { token: this.issue(s, uid) };
  }
}
