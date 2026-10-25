import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SecretJsonFile } from '../security/secret-json-file';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { publicOrigin } from '../config/cors';
import { UsersService } from '../users/users.service';
import { SessionsService, type SessionMeta } from './sessions.service';
import {
  LoginLimiter,
  canRemovePassword,
  hashPassword,
  signSession,
  hashRecovery,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  verifyTotp,
  tokenFromRequest,
  validatePassword,
  verifyPassword,
  verifySession,
} from './auth-core';

interface UserCred {
  hash: string;
  /** Bumped when this user's password changes or is removed — signs that user out everywhere. */
  epoch: number;
  /** Two-factor sign-in (an authenticator app). `lastStep` = newest accepted time step (a code works once); `recovery` = hashes of unused one-time codes. */
  totp?: { secret: string; lastStep: number; recovery: string[] };
  /** A secret shown to the user but not confirmed yet (it only becomes `totp` when a code from the app proves it was scanned). */
  pendingTotp?: string;
}
interface AuthState {
  /** HMAC key for session cookies. */
  secret: string;
  /** Global epoch ("sign out everyone"). */
  epoch: number;
  users: Record<string, UserCred>;
  /** Users whose two-factor sign-in is required: they set it up at their next sign-in and cannot turn it off themselves. */
  requireTwoFactor?: Record<string, boolean>;
  /** Pre-multi-user file: one password for the default operator. Migrated at startup. */
  passwordHash?: string;
}

export interface LoginUser {
  id: string;
  displayName: string;
  role: string;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status?: number; needsCode?: boolean; needsSetup?: { secret: string; uri: string } };

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
  /** Per ACCOUNT (X-CF-1): many addresses guessing one password still hit a wall; more generous than the per-address limit so one attacker cannot lock the owner out cheaply. */
  private readonly accountLimiter = new LoginLimiter(15);

  constructor(
    private readonly config: AppConfigService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
  ) {}

  private get file(): string {
    return join(this.config.secretsDir, 'auth.json');
  }

  private store?: SecretJsonFile<AuthState | null>;
  private get json(): SecretJsonFile<AuthState | null> {
    return (this.store ??= new SecretJsonFile<AuthState | null>(this.file, {
      missing: null,
      parse: (raw) => {
        const s = raw as Partial<AuthState>;
        return s.secret && Number.isFinite(s.epoch)
          ? { secret: s.secret, epoch: s.epoch!, users: s.users && typeof s.users === 'object' ? s.users : {}, passwordHash: s.passwordHash, requireTwoFactor: s.requireTwoFactor && typeof s.requireTwoFactor === 'object' ? s.requireTwoFactor : undefined }
          : null;
      },
    }));
  }

  /** Current state, cached for a couple of seconds (re-read when the file changed, e.g. removed by `make reset-password`). */
  private state(): AuthState | null {
    return this.json.read();
  }

  private write(s: AuthState): void {
    this.json.write(s);
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
          'Set one in the dashboard (Settings → Security) or with ADMIN_PASSWORD.',
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
    if (this.sessions.isRevoked(p.sid)) return null;
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

  /** Logging out ends THIS session on the server too (not just the browser's cookie), so it also disappears from the list. */
  async endCurrentSession(headers: Record<string, string | string[] | undefined>): Promise<void> {
    const sid = this.sessionIdOf(headers);
    if (sid && this.sessionUserId(headers)) await this.sessions.revokeOwn(sid);
  }

  /** The session id carried by this request's cookie (for "this device" in the list and for noting activity). */
  sessionIdOf(headers: Record<string, string | string[] | undefined>): string | undefined {
    const s = this.state();
    return s ? verifySession(s.secret, tokenFromRequest(headers))?.sid : undefined;
  }

  private issue(s: AuthState, uid: string, meta?: SessionMeta): string {
    const exp = Date.now() + this.sessionDays() * 86_400_000;
    const sid = this.sessions.newId();
    this.sessions.record(sid, uid, new Date(exp), meta);
    return signSession(s.secret, { exp, epoch: s.epoch, uid, ue: s.users[uid]!.epoch, sid });
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
  async passwordOverview(): Promise<{ id: string; hasPassword: boolean; twoFactor: boolean; twoFactorRequired: boolean }[]> {
    const s = this.state();
    return (await this.users.list()).map((u) => ({ id: u.id, hasPassword: !!s?.users[u.id], twoFactor: !!s?.users[u.id]?.totp, twoFactorRequired: !!s?.requireTwoFactor?.[u.id] }));
  }

  /** First password ever: belongs to the default operator. Only while sign-in is off. */
  async setup(password: unknown, meta?: SessionMeta): Promise<Result<{ token: string; uid: string }>> {
    if (this.isConfigured()) return { ok: false, error: 'A password is already set.' };
    const bad = validatePassword(password);
    if (bad) return { ok: false, error: bad };
    const op = await this.users.defaultOperator();
    const s = this.fresh();
    s.users[op.id] = { hash: hashPassword(password as string), epoch: 1 };
    this.write(s);
    return { ok: true, token: this.issue(s, op.id, meta), uid: op.id };
  }

  /** `user` is an id or (for scripts) a display name; omitted = the only user who has a password. */
  async login(user: unknown, password: unknown, key: string, meta?: SessionMeta, code?: unknown): Promise<Result<{ token: string; uid: string; recoveryCodes?: string[] }>> {
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
    const acctWait = u ? this.accountLimiter.wait(u.id) : 0;
    if (acctWait > 0) return { ok: false, error: `Too many attempts — try again in ${acctWait}s.`, status: 429 };
    // Same work and same message whether the user or the password is wrong.
    if (!u || !cred || typeof password !== 'string' || !verifyPassword(password, cred.hash)) {
      this.limiter.fail(key);
      if (u) this.accountLimiter.fail(u.id);
      return { ok: false, error: 'Wrong password.', status: 401 };
    }
    let recoveryCodes: string[] | undefined;
    if (!cred.totp && s.requireTwoFactor?.[u.id]) {
      // Required for this person but not set up yet: no session until it is. The password was right, so the setup is offered (secret kept as `pendingTotp`, the same one on a retry);
      // the next request carries the first code, which proves the app was set up, turns it on and signs in.
      const pending = cred.pendingTotp ?? newTotpSecret();
      if (!cred.pendingTotp) {
        s.users[u.id] = { ...cred, pendingTotp: pending };
        this.write(s);
      }
      const offer = { secret: pending, uri: otpauthUri(pending, u.displayName) };
      if (code === undefined || code === null || code === '') return { ok: false, error: 'Two-factor sign-in is required: set it up in your authenticator app, then type the code it shows.', status: 401, needsSetup: offer };
      const step = verifyTotp(pending, code);
      if (step === null) {
        this.limiter.fail(key);
        this.accountLimiter.fail(u.id);
        return { ok: false, error: 'That code does not match — check the time on your phone and try the next code.', status: 401, needsSetup: offer };
      }
      recoveryCodes = this.activate(s, u.id, step);
    } else if (cred.totp) {
      // The password was right; the second factor is asked for without counting it as a failure — the limiters reset only once the code is right too.
      if (code === undefined || code === null || code === '') return { ok: false, error: 'Enter the 6-digit code from your authenticator app (or a recovery code).', status: 401, needsCode: true };
      if (!this.acceptSecondFactor(s, u.id, code)) {
        this.limiter.fail(key);
        this.accountLimiter.fail(u.id);
        return { ok: false, error: 'Wrong code.', status: 401, needsCode: true };
      }
    }
    this.limiter.ok(key);
    this.accountLimiter.ok(u.id);
    return { ok: true, token: this.issue(s, u.id, meta), uid: u.id, ...(recoveryCodes ? { recoveryCodes } : {}) };
  }

  /** Turns two-factor on from a confirmed pending secret; returns the recovery codes (shown once). */
  private activate(s: AuthState, uid: string, step: number): string[] {
    const cred = s.users[uid]!;
    const codes = newRecoveryCodes();
    const { pendingTotp, ...rest } = cred;
    s.users[uid] = { ...rest, totp: { secret: pendingTotp!, lastStep: step, recovery: codes.map(hashRecovery) } };
    this.write(s);
    return codes;
  }

  /** A current authenticator code (never the same step twice) or an unused recovery code (spent here). Saves what it consumed. */
  private acceptSecondFactor(s: AuthState, uid: string, code: unknown): boolean {
    const cred = s.users[uid];
    const t = cred?.totp;
    if (!cred || !t) return false;
    const step = verifyTotp(t.secret, code, Date.now(), t.lastStep);
    if (step !== null) {
      s.users[uid] = { ...cred, totp: { ...t, lastStep: step } };
      this.write(s);
      return true;
    }
    if (typeof code === 'string' && /^[a-z0-9]{4}[\s-]?[a-z0-9]{4}$/i.test(code.trim())) {
      const h = hashRecovery(code);
      if (t.recovery.includes(h)) {
        s.users[uid] = { ...cred, totp: { ...t, recovery: t.recovery.filter((x) => x !== h) } };
        this.write(s);
        return true;
      }
    }
    return false;
  }

  twoFactorStatus(uid: string): { enabled: boolean; recoveryLeft: number; required: boolean } {
    const st = this.state();
    const t = st?.users[uid]?.totp;
    return { enabled: !!t, recoveryLeft: t?.recovery.length ?? 0, required: !!st?.requireTwoFactor?.[uid] };
  }

  /** Step 1 of turning it on: needs your password; returns the secret (and the link an authenticator app opens). Nothing is active yet. */
  async beginTwoFactor(uid: string, password: unknown, key: string): Promise<Result<{ secret: string; uri: string }>> {
    const s = this.state();
    const cred = s?.users[uid];
    if (!s || !cred) return { ok: false, error: 'No password is set for you.' };
    if (cred.totp) return { ok: false, error: 'Two-factor sign-in is already on. Turn it off first to set it up again.' };
    const wait = this.limiter.wait(key);
    if (wait > 0) return { ok: false, error: `Too many attempts — try again in ${wait}s.`, status: 429 };
    if (typeof password !== 'string' || !verifyPassword(password, cred.hash)) {
      this.limiter.fail(key);
      return { ok: false, error: 'The password is wrong.', status: 401 };
    }
    const secret = newTotpSecret();
    s.users[uid] = { ...cred, pendingTotp: secret };
    this.write(s);
    const me = await this.userById(uid);
    return { ok: true, secret, uri: otpauthUri(secret, me?.displayName ?? uid) };
  }

  /** Step 2: a code from the app proves it was scanned; two-factor turns on and the recovery codes are shown once. */
  enableTwoFactor(uid: string, code: unknown, key: string): Result<{ recoveryCodes: string[] }> {
    const s = this.state();
    const cred = s?.users[uid];
    if (!s || !cred?.pendingTotp) return { ok: false, error: 'Start the setup first.' };
    const wait = this.limiter.wait(key);
    if (wait > 0) return { ok: false, error: `Too many attempts — try again in ${wait}s.`, status: 429 };
    const step = verifyTotp(cred.pendingTotp, code);
    if (step === null) {
      this.limiter.fail(key);
      return { ok: false, error: 'That code does not match — check the time on your phone and try the next code.' };
    }
    const codes = this.activate(s, uid, step);
    return { ok: true, recoveryCodes: codes };
  }

  /** Needs the password AND a code (or recovery code): a stolen session alone cannot switch it off. */
  disableTwoFactor(uid: string, password: unknown, code: unknown, key: string): Result<object> {
    if (this.state()?.requireTwoFactor?.[uid]) return { ok: false, error: 'An administrator requires two-factor sign-in for your account — it cannot be turned off here.' };
    const checked = this.checkBoth(uid, password, code, key);
    if (!checked.ok) return checked;
    const s = this.state()!;
    const { totp, pendingTotp, ...rest } = s.users[uid]!;
    void totp;
    void pendingTotp;
    s.users[uid] = rest;
    this.write(s);
    return { ok: true };
  }

  /** A fresh set of recovery codes (the old ones stop working). Same proof as turning it off. */
  newRecoveryCodes(uid: string, password: unknown, code: unknown, key: string): Result<{ recoveryCodes: string[] }> {
    const checked = this.checkBoth(uid, password, code, key);
    if (!checked.ok) return checked;
    const s = this.state()!;
    const cred = s.users[uid]!;
    const codes = newRecoveryCodes();
    s.users[uid] = { ...cred, totp: { ...cred.totp!, recovery: codes.map(hashRecovery) } };
    this.write(s);
    return { ok: true, recoveryCodes: codes };
  }

  private checkBoth(uid: string, password: unknown, code: unknown, key: string): Result<object> {
    const s = this.state();
    const cred = s?.users[uid];
    if (!s || !cred?.totp) return { ok: false, error: 'Two-factor sign-in is not on.' };
    const wait = this.limiter.wait(key);
    if (wait > 0) return { ok: false, error: `Too many attempts — try again in ${wait}s.`, status: 429 };
    if (typeof password !== 'string' || !verifyPassword(password, cred.hash) || !this.acceptSecondFactor(s, uid, code)) {
      this.limiter.fail(key);
      return { ok: false, error: 'The password or the code is wrong.', status: 401 };
    }
    return { ok: true };
  }

  /** A manager makes two-factor sign-in required for a user (or not): they set it up at their next sign-in. Needs sign-in to be on. */
  async setRequireTwoFactor(targetId: string, required: boolean): Promise<Result<object>> {
    const s = this.state();
    if (!s) return { ok: false, error: 'Set the first password in Security before requiring two-factor sign-in.' };
    if (!(await this.userById(targetId))) return { ok: false, error: 'No such user.', status: 404 };
    const map = { ...(s.requireTwoFactor ?? {}) };
    if (required) map[targetId] = true;
    else delete map[targetId];
    s.requireTwoFactor = Object.keys(map).length ? map : undefined;
    this.write(s);
    return { ok: true };
  }

  /** A manager removes someone's second factor (a lost phone). That person is signed out everywhere and sets it up again if they want. */
  async resetUserTwoFactor(targetId: string): Promise<Result<object>> {
    const s = this.state();
    const cred = s?.users[targetId];
    if (!s || !cred?.totp) return { ok: false, error: 'That user has no two-factor sign-in.', status: 404 };
    const { totp, pendingTotp, ...rest } = cred;
    void totp;
    void pendingTotp;
    s.users[targetId] = { ...rest, epoch: cred.epoch + 1 };
    this.write(s);
    await this.sessions.purge(targetId);
    return { ok: true };
  }

  /** Change your own password (needs the current one). Signs your other browsers out. */
  async changeOwnPassword(uid: string, current: unknown, next: unknown, key: string, meta?: SessionMeta): Promise<Result<{ token: string }>> {
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
    s.users[uid] = { ...cred, hash: hashPassword(next as string), epoch: cred.epoch + 1 };
    this.write(s);
    await this.sessions.purge(uid); // every other cookie of this user just stopped working
    return { ok: true, token: this.issue(s, uid, meta) };
  }

  /** A manager sets (or resets) someone's password. That user is signed out everywhere. */
  async setUserPassword(targetId: string, password: unknown): Promise<Result<object>> {
    const s = this.state();
    if (!s) return { ok: false, error: 'Set the first password in Security before adding others.' };
    if (!(await this.userById(targetId))) return { ok: false, error: 'No such user.', status: 404 };
    const bad = validatePassword(password);
    if (bad) return { ok: false, error: bad };
    s.users[targetId] = { ...s.users[targetId], hash: hashPassword(password as string), epoch: (s.users[targetId]?.epoch ?? 0) + 1 };
    this.write(s);
    await this.sessions.purge(targetId);
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
    await this.sessions.purge(targetId);
    return { ok: true };
  }

  /**
   * End ALL of one person's sessions (without touching their password): bumps their epoch. With `keepMeta` the caller is that person and
   * stays signed in here — a fresh session is issued and its token returned.
   */
  async revokeUserSessions(targetId: string, keepMeta?: SessionMeta): Promise<Result<{ token?: string }>> {
    const s = this.state();
    const cred = s?.users[targetId];
    if (!s || !cred) return { ok: false, error: 'That user has no sessions (no password).', status: 404 };
    s.users[targetId] = { ...cred, epoch: cred.epoch + 1 };
    this.write(s);
    await this.sessions.purge(targetId);
    return { ok: true, ...(keepMeta ? { token: this.issue(s, targetId, keepMeta) } : {}) };
  }

  /** Sign everyone else out; keep the caller signed in. */
  async signOutEverywhere(uid: string, meta?: SessionMeta): Promise<{ token: string } | null> {
    const s = this.state();
    if (!s?.users[uid]) return null;
    s.secret = randomBytes(32).toString('base64url');
    s.epoch += 1;
    this.write(s);
    await this.sessions.purge(); // the signing key changed: every session ended
    return { token: this.issue(s, uid, meta) };
  }
}
