/**
 * Which `Host` names this instance answers to. Pure logic, unit-tested.
 *
 * Rule of thumb: names that cannot be someone else's website — localhost, any IP address, a single-word name
 * (a LAN host or docker service) — are ALWAYS accepted, so port forwarding / ssh -L / opening the server by IP keeps
 * working exactly as before. Only real domain names (with a dot) are subject to the allow-list, and only once an
 * allow-list exists (set in Settings, or implied by PUBLIC_URL). That blocks DNS-rebinding and a tunnel hostname you did
 * not intend to publish, without ever locking you out of your own server.
 */
import { isIP } from 'node:net';

/** `Host` header → bare lower-case hostname (no port, no brackets, no trailing dot). */
export function normalizeHost(raw: string | undefined): string {
  let h = (raw ?? '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h;
  }
  const colons = (h.match(/:/g) ?? []).length;
  if (colons === 1) h = h.slice(0, h.indexOf(':'));
  return h.replace(/\.$/, '');
}

/** Always accepted: loopback names, IP literals, single-label names. */
export function isAlwaysAllowed(host: string): boolean {
  if (!host) return false;
  if (isIP(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return !host.includes('.');
}

/** What a user may type: a domain, `*.domain`, or a full URL — reduced to a bare lower-case entry, or null if unusable. */
export function parseDomainEntry(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  const wildcard = s.startsWith('*.');
  const name = wildcard ? s.slice(2) : s;
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name) && !/^xn--/.test(name)) return null;
  return wildcard ? `*.${name}` : name;
}

export function parseDomainList(inputs: unknown): { list: string[]; bad: string[] } {
  const raw = Array.isArray(inputs) ? inputs : typeof inputs === 'string' ? inputs.split(/[\s,;]+/) : [];
  const list: string[] = [];
  const bad: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !r.trim()) continue;
    const d = parseDomainEntry(r);
    if (!d) bad.push(r.trim().slice(0, 80));
    else if (!list.includes(d)) list.push(d);
  }
  return { list: list.slice(0, 50), bad };
}

/** Is this Host header acceptable? No allow-list = everything (the behaviour before this feature). */
export function hostAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const host = normalizeHost(hostHeader);
  if (!host) return false;
  if (isAlwaysAllowed(host)) return true;
  return allowed.some((a) => (a.startsWith('*.') ? host.endsWith(a.slice(1)) && host.length > a.length - 1 : host === a));
}

/** Does this Host match one of the allowed DOMAINS (no free pass for IPs / local names)? */
export function domainAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  const host = normalizeHost(hostHeader);
  if (!host) return false;
  return allowed.some((a) => (a.startsWith('*.') ? host.endsWith(a.slice(1)) && host.length > a.length - 1 : host === a));
}

/**
 * The request-level rule. Normal mode = `hostAllowed` (IPs, localhost and single-word names always pass).
 * Strict mode (with a non-empty domain list): anyone not on this machine must come in under an allowed DOMAIN — an IP address or a bare
 * server name gets refused, and a forged `Host: localhost` does not help from outside. A request from this machine itself (agent hooks,
 * health checks, an SSH tunnel) still passes — unless it was relayed by a proxy/tunnel (forwarding headers), which counts as outside.
 */
export function requestAllowed(opts: { host: string | undefined; allowed: readonly string[]; strict: boolean; fromThisMachine: boolean; relayed: boolean }): boolean {
  if (!opts.strict || opts.allowed.length === 0) return hostAllowed(opts.host, opts.allowed);
  if (opts.fromThisMachine && !opts.relayed) return true;
  return domainAllowed(opts.host, opts.allowed);
}
