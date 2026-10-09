import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { isAlwaysAllowed, normalizeHost } from './access-core';
import {
  accessTokenFrom,
  parseAud,
  parseTeamDomain,
  tokenKid,
  verifyAccessJwt,
  type AccessConfig,
  type AccessJwk,
  type JwtResult,
} from './cloudflare-access-core';

const KEYS_TTL_MS = 10 * 60_000;
const REFETCH_MIN_MS = 60_000;

/**
 * Cloudflare Access as a second, independent gate (Settings → General → Cloudflare Access, `aigentron access`). When on, a request
 * that arrives under a real domain name (not localhost / an IP / a single-word LAN name — those always work) must carry a valid
 * Cloudflare Access token, so reaching the origin around Cloudflare (a tunnel hostname without an Access policy) gets you nothing.
 * Stored in `<secretsDir>/cloudflare-access.json`, beside the other access files the approval gate guards.
 */
@Injectable()
export class CloudflareAccessService {
  private readonly logger = new Logger('CloudflareAccess');
  private cfg: { mtime: number; value: AccessConfig | null } = { mtime: -1, value: null };
  private keys = new Map<string, { at: number; fetchedAt: number; keys: AccessJwk[] }>();

  constructor(private readonly config: AppConfigService) {}

  private get file(): string {
    return join(this.config.secretsDir, 'cloudflare-access.json');
  }

  get(): AccessConfig | null {
    let mtime = 0;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      this.cfg = { mtime: 0, value: null };
      return null;
    }
    if (mtime !== this.cfg.mtime) {
      let value: AccessConfig | null = null;
      try {
        const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AccessConfig>;
        const teamDomain = parseTeamDomain(j.teamDomain);
        const aud = parseAud(j.aud);
        if (teamDomain && aud) value = { enabled: j.enabled === true, teamDomain, aud };
      } catch {
        value = null;
      }
      this.cfg = { mtime, value };
    }
    return this.cfg.value;
  }

  /** Does a request for this Host have to carry a valid Access token? */
  required(hostHeader: string | undefined): boolean {
    const c = this.get();
    return Boolean(c?.enabled) && !isAlwaysAllowed(normalizeHost(hostHeader));
  }

  private async signingKeys(team: string, kid: string | null, force = false): Promise<AccessJwk[]> {
    const cached = this.keys.get(team);
    const now = Date.now();
    const fresh = cached && now - cached.at < KEYS_TTL_MS;
    const unknownKid = Boolean(kid) && Boolean(cached) && !cached!.keys.some((k) => k.kid === kid);
    if (fresh && !unknownKid && !force) return cached!.keys;
    if (cached && now - cached.fetchedAt < REFETCH_MIN_MS && !force) return cached.keys; // don't hammer Cloudflare on junk tokens
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Cloudflare answered ${res.status} for the signing keys`);
    const j = (await res.json()) as { keys?: AccessJwk[] };
    const list = Array.isArray(j.keys) ? j.keys : [];
    this.keys.set(team, { at: now, fetchedAt: now, keys: list });
    return list;
  }

  /** Can we fetch Cloudflare's signing keys for this team? (used to sanity-check the team domain before saving) */
  async reachable(teamDomain: string): Promise<{ ok: true; keys: number } | { ok: false; error: string }> {
    try {
      return { ok: true, keys: (await this.signingKeys(teamDomain, null, true)).length };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Verify the token on a request. Fails closed: if Cloudflare's keys cannot be fetched, the request is refused. */
  async check(headers: Record<string, string | string[] | undefined>): Promise<JwtResult> {
    const c = this.get();
    if (!c) return { ok: false, error: 'Cloudflare Access is not configured' };
    const token = accessTokenFrom(headers);
    if (!token) return { ok: false, error: 'no Cloudflare Access token' };
    try {
      return verifyAccessJwt(token, await this.signingKeys(c.teamDomain, tokenKid(token)), c);
    } catch (e) {
      this.logger.warn(`could not verify a token: ${(e as Error).message}`);
      return { ok: false, error: 'could not reach Cloudflare to check the token' };
    }
  }

  /** Save. Refuses to switch ON for a caller who is on a public domain without a valid token (they would be locked out). */
  async save(input: { enabled?: unknown; teamDomain?: unknown; aud?: unknown }, callerHost: string | undefined, callerHeaders: Record<string, string | string[] | undefined>): Promise<{ ok: true; config: AccessConfig } | { ok: false; error: string }> {
    const teamDomain = parseTeamDomain(input.teamDomain);
    if (!teamDomain) return { ok: false, error: 'The team domain looks like yourteam.cloudflareaccess.com (Zero Trust → Settings → Custom pages / Team domain).' };
    const prev = this.get();
    const audIn = typeof input.aud === 'string' && input.aud.trim() ? input.aud : prev?.aud;
    const aud = parseAud(audIn);
    if (!aud) return { ok: false, error: 'The Application Audience (AUD) tag is the long code on the Access application\'s Overview page.' };
    const enabled = input.enabled === true;
    const next: AccessConfig = { enabled, teamDomain, aud };
    // callerHost is empty for a change made on the server's behalf (the admin agent, after a human approved it)
    if (enabled && callerHost && !isAlwaysAllowed(normalizeHost(callerHost))) {
      this.cfg = { mtime: -1, value: null };
      const probe = await this.checkWith(next, callerHeaders);
      if (!probe.ok) return { ok: false, error: `You are connected through ${normalizeHost(callerHost)} without a valid Cloudflare Access sign-in (${probe.error}) — turning this on would lock you out. Make this change from localhost / the server's IP, or fix the Access policy first.` };
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.cfg = { mtime: -1, value: null };
    this.keys.delete(teamDomain);
    return { ok: true, config: next };
  }

  private async checkWith(c: AccessConfig, headers: Record<string, string | string[] | undefined>): Promise<JwtResult> {
    const token = accessTokenFrom(headers);
    if (!token) return { ok: false, error: 'no Cloudflare Access token' };
    try {
      return verifyAccessJwt(token, await this.signingKeys(c.teamDomain, tokenKid(token), true), c);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** For the Test button: can we fetch Cloudflare's keys, and is THIS request carrying a valid token (who is it)? */
  async test(headers: Record<string, string | string[] | undefined>): Promise<{ keys: { ok: boolean; count?: number; error?: string }; you: { present: boolean; ok?: boolean; email?: string | null; error?: string } }> {
    const c = this.get();
    if (!c) return { keys: { ok: false, error: 'Save the team domain and AUD first.' }, you: { present: false } };
    let keys: { ok: boolean; count?: number; error?: string };
    try {
      keys = { ok: true, count: (await this.signingKeys(c.teamDomain, null, true)).length };
    } catch (e) {
      keys = { ok: false, error: (e as Error).message };
    }
    const token = accessTokenFrom(headers);
    if (!token) return { keys, you: { present: false } };
    const r = await this.check(headers);
    return { keys, you: r.ok ? { present: true, ok: true, email: r.email } : { present: true, ok: false, error: r.error } };
  }
}
