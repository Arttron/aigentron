/**
 * The server's own web listeners (ports 80 / 443) and its TLS certificate — pure logic, unit-tested.
 *
 * Rule: port 3001 (the API/dashboard port) is always there. Port 80 is OPTIONAL (off by default — switch it on in Settings or
 * `aigentron access`). Once a certificate is added the server serves HTTPS on 443, and port 80 (if on) turns into a redirect to
 * HTTPS for real domain names (IP addresses, localhost and single-word names keep working over plain HTTP, exactly like the
 * domain allow-list treats them).
 */
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { isAlwaysAllowed, normalizeHost } from '../access/access-core';

export interface WebServerConfig {
  /** Plain HTTP port; 0 = off. Default 0 (off) — turn port 80 on when you want it. */
  httpPort: number;
  /** HTTPS port (used only while a certificate is installed); 0 = off. Default 443. */
  httpsPort: number;
  /** With a certificate: answer port 80 with a redirect to HTTPS (for domain names). Default true. */
  redirect: boolean;
}

export const DEFAULT_WEB_CONFIG: WebServerConfig = { httpPort: 0, httpsPort: 443, redirect: true };

const portOf = (v: unknown, def: number): number | null => {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;
};

/** Validate user input into a full config (missing fields keep `base`). */
export function parseWebConfig(input: unknown, apiPort: number, base: WebServerConfig = DEFAULT_WEB_CONFIG): { ok: true; config: WebServerConfig } | { ok: false; error: string } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const httpPort = portOf(i.httpPort, base.httpPort);
  const httpsPort = portOf(i.httpsPort, base.httpsPort);
  if (httpPort === null) return { ok: false, error: 'The HTTP port must be a number from 1 to 65535 (0 = off).' };
  if (httpsPort === null) return { ok: false, error: 'The HTTPS port must be a number from 1 to 65535 (0 = off).' };
  if (httpPort && httpPort === httpsPort) return { ok: false, error: 'The HTTP and HTTPS ports must differ.' };
  for (const [name, p] of [['HTTP', httpPort], ['HTTPS', httpsPort]] as const) {
    if (p && p === apiPort) return { ok: false, error: `${name} port ${p} is already the API port.` };
  }
  const redirect = typeof i.redirect === 'boolean' ? i.redirect : base.redirect;
  return { ok: true, config: { httpPort, httpsPort, redirect } };
}

export interface CertInfo {
  subject: string;
  issuer: string;
  /** DNS names the certificate is valid for. */
  names: string[];
  validFrom: string;
  validTo: string;
  daysLeft: number;
  selfSigned: boolean;
}

/** Does a certificate name (possibly `*.example.com`) cover this host? */
export function nameCovers(name: string, host: string): boolean {
  const n = name.toLowerCase();
  const h = host.toLowerCase();
  if (n === h) return true;
  if (n.startsWith('*.')) {
    const rest = n.slice(1); // ".example.com"
    return h.endsWith(rest) && h.slice(0, -rest.length).length > 0 && !h.slice(0, -rest.length).includes('.');
  }
  return false;
}

const cnOf = (dn: string): string => /(?:^|\n)CN=([^\n]+)/.exec(dn)?.[1] ?? dn.replace(/\n/g, ', ');

/** Read a PEM certificate (+ optionally check the private key belongs to it). */
export function inspectCertificate(certPem: string, keyPem?: string, now = Date.now()): { ok: true; info: CertInfo } | { ok: false; error: string } {
  let x: X509Certificate;
  try {
    x = new X509Certificate(certPem);
  } catch {
    return { ok: false, error: 'That is not a valid PEM certificate (it should start with -----BEGIN CERTIFICATE-----).' };
  }
  if (keyPem !== undefined) {
    try {
      if (!x.checkPrivateKey(createPrivateKey(keyPem))) return { ok: false, error: 'The private key does not belong to this certificate.' };
    } catch {
      return { ok: false, error: 'That is not a valid private key in PEM form (-----BEGIN PRIVATE KEY----- / RSA / EC; it must not be password-protected).' };
    }
  }
  const to = new Date(x.validTo).getTime();
  const from = new Date(x.validFrom).getTime();
  if (Number.isNaN(to) || to < now) return { ok: false, error: `The certificate expired on ${x.validTo}.` };
  if (from > now + 5 * 60_000) return { ok: false, error: `The certificate is not valid yet (from ${x.validFrom}).` };
  const san = (x.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4).toLowerCase());
  const cn = cnOf(x.subject).toLowerCase();
  const names = san.length ? san : cn ? [cn] : [];
  return {
    ok: true,
    info: {
      subject: cnOf(x.subject),
      issuer: cnOf(x.issuer),
      names,
      validFrom: new Date(from).toISOString(),
      validTo: new Date(to).toISOString(),
      daysLeft: Math.floor((to - now) / 86_400_000),
      selfSigned: x.subject === x.issuer,
    },
  };
}

/** Where plain-HTTP port 80 sends a request once HTTPS is on: a URL for domain names, null (= serve normally) otherwise. */
export function redirectTarget(hostHeader: string | undefined, url: string, httpsPort: number): string | null {
  const host = normalizeHost(hostHeader);
  if (!host || isAlwaysAllowed(host)) return null;
  const hostPart = host.includes(':') ? `[${host}]` : host;
  return `https://${hostPart}${httpsPort === 443 ? '' : `:${httpsPort}`}${url || '/'}`;
}
