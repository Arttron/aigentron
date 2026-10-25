import { join } from 'node:path';
import { SecretJsonFile } from '../security/secret-json-file';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { publicOrigin } from '../config/cors';
import { isThisMachine } from '../auth/auth-core';
import { ownAddresses } from './own-addresses';
import { hostAllowed, isAlwaysAllowed, normalizeHost, parseDomainList, requestAllowed } from './access-core';

/**
 * The domains this instance answers to (Settings → Security → Access). Stored in `<secretsDir>/access.json` — beside
 * the sign-in file, in the directory the approval gate guards, so an agent cannot quietly widen it. Empty list (and no
 * PUBLIC_URL) = no restriction, exactly as before. Local names, IP addresses and single-word hosts always work.
 */
@Injectable()
export class AccessService {
  constructor(private readonly config: AppConfigService) {}

  private get file(): string {
    return join(this.config.secretsDir, 'access.json');
  }

  private store?: SecretJsonFile<{ hosts: string[]; strict: boolean }>;
  private get json(): SecretJsonFile<{ hosts: string[]; strict: boolean }> {
    return (this.store ??= new SecretJsonFile(this.file, {
      missing: { hosts: [], strict: false },
      parse: (raw) => {
        const j = raw as { allowedHosts?: unknown; strict?: unknown };
        return { hosts: parseDomainList(j.allowedHosts).list, strict: j.strict === true };
      },
    }));
  }

  /** Domains set in Settings. */
  configured(): string[] {
    return this.json.read().hosts;
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

  /** Strict mode (Settings → Security → Access): refuse IP addresses and bare server names from outside — only the allowed domains. */
  strict(): boolean {
    return this.json.read().strict && this.effective().length > 0;
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
    const strict = opts.strict ?? this.json.read().strict;
    if (strict && next.length && me && !opts.callerLocal && isAlwaysAllowed(me)) {
      return { ok: false, error: `Strict mode refuses IP addresses and bare names from outside — you are connected through ${me}. Open the dashboard through one of your allowed domains (or from the server itself / an SSH tunnel) to switch it on.` };
    }
    this.json.write({ allowedHosts: list, strict });
    return { ok: true, hosts: list, strict };
  }
}
