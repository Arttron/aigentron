import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { publicOrigin } from '../config/cors';
import { isThisMachine } from '../auth/auth-core';
import { ownAddresses } from './own-addresses';
import { hostAllowed, isAlwaysAllowed, normalizeHost, parseDomainList, requestAllowed } from './access-core';

/**
 * The domains this instance answers to (Settings → General → Access). Stored in `<secretsDir>/access.json` — beside
 * the sign-in file, in the directory the approval gate guards, so an agent cannot quietly widen it. Empty list (and no
 * PUBLIC_URL) = no restriction, exactly as before. Local names, IP addresses and single-word hosts always work.
 */
@Injectable()
export class AccessService {
  private cache: { mtime: number; hosts: string[]; strict: boolean } = { mtime: -1, hosts: [], strict: false };

  constructor(private readonly config: AppConfigService) {}

  private get file(): string {
    return join(this.config.secretsDir, 'access.json');
  }

  /** Domains set in Settings. */
  configured(): string[] {
    let mtime = 0;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      this.cache = { mtime: 0, hosts: [], strict: false };
      return [];
    }
    if (mtime !== this.cache.mtime) {
      try {
        const j = JSON.parse(readFileSync(this.file, 'utf8')) as { allowedHosts?: unknown; strict?: unknown };
        this.cache = { mtime, hosts: parseDomainList(j.allowedHosts).list, strict: j.strict === true };
      } catch {
        this.cache = { mtime, hosts: [], strict: false };
      }
    }
    return this.cache.hosts;
  }

  /** The host of PUBLIC_URL (always allowed once set). */
  publicHost(): string | null {
    const o = publicOrigin(process.env.PUBLIC_URL);
    return o ? normalizeHost(new URL(o).host) : null;
  }

  /** Everything enforced: the Settings list plus PUBLIC_URL's host. Empty = unrestricted. */
  effective(): string[] {
    const ph = this.publicHost();
    const list = this.configured();
    return ph && !list.includes(ph) ? [...list, ph] : list;
  }

  /** Strict mode (Settings → Access): refuse IP addresses and bare server names from outside — only the allowed domains. */
  strict(): boolean {
    this.configured();
    return this.cache.strict && this.effective().length > 0;
  }

  allows(hostHeader: string | undefined): boolean {
    return hostAllowed(hostHeader, this.effective());
  }

  /** Is this request acceptable? (host + where it came from; strict mode looks at the TCP peer and forwarding headers.) */
  allowsRequest(hostHeader: string | undefined, peer: string | undefined, headers: Record<string, string | string[] | undefined> = {}): boolean {
    const relayed = Boolean(headers['x-forwarded-for'] || headers['forwarded'] || headers['cf-connecting-ip'] || headers['x-real-ip']);
    return requestAllowed({ host: hostHeader, allowed: this.effective(), strict: this.strict(), fromThisMachine: isThisMachine(peer, ownAddresses()), relayed });
  }

  /** Save the list. Refuses a list that would block the address the caller is using right now. */
  save(input: unknown, callerHost: string | undefined, opts: { strict?: boolean; callerLocal?: boolean } = {}): { ok: true; hosts: string[]; strict: boolean } | { ok: false; error: string } {
    const { list, bad } = parseDomainList(input);
    if (bad.length) return { ok: false, error: `Not a domain name: ${bad.join(', ')}. Use something like dev.example.com or *.example.com.` };
    const next = [...list];
    const ph = this.publicHost();
    if (ph && !next.includes(ph)) next.push(ph);
    const me = normalizeHost(callerHost);
    if (next.length && me && !isAlwaysAllowed(me) && !hostAllowed(callerHost, next)) {
      return { ok: false, error: `That list would lock out the address you are using right now (${me}). Add it, or make this change from localhost / the server's IP.` };
    }
    const strict = opts.strict ?? this.cache.strict;
    if (strict && next.length && me && !opts.callerLocal && isAlwaysAllowed(me)) {
      return { ok: false, error: `Strict mode refuses IP addresses and bare names from outside — you are connected through ${me}. Open the dashboard through one of your allowed domains (or from the server itself / an SSH tunnel) to switch it on.` };
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ allowedHosts: list, strict }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.cache = { mtime: -1, hosts: [], strict: false };
    return { ok: true, hosts: list, strict };
  }
}
