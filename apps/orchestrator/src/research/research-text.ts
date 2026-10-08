import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';

/** Addresses the fetch tool must never reach (SSRF): loopback, private, link-local/metadata, CGNAT… */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(addr: string): boolean {
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // IPv4-mapped IPv6
  const a = mapped ? mapped[1]! : addr;
  const fam = isIP(a);
  if (!fam) return true;
  return PRIVATE.check(a, fam === 4 ? 'ipv4' : 'ipv6');
}

/** DNS lookup that refuses private/internal targets at connect time (also defeats DNS rebinding). */
export function safeLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  cb: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
): void {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error(`refusing to connect to a private/internal address for ${hostname}`), { code: 'EACCES' }));
    }
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0]!.address, addrs[0]!.family);
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…', sect: '§', copy: '©', deg: '°' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Lightweight HTML → readable text that keeps headings and paragraph breaks (clause numbers survive). */
export function htmlToText(html: string): { title: string; text: string; lastModified: string | null } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const meta =
    html.match(/<meta[^>]+(?:name|property)=["'](?:dcterms?\.(?:modified|date)|dc\.date|article:modified_time|last-modified|date)["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] ??
    null;
  // Prefer the page's main content (skips site menus, banners and cookie notices) when it has one.
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  let s = (main && main.length > 400 ? main : html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|table|ul|ol|blockquote|pre)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  const text = s
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text, lastModified: meta };
}

/** Normalise for quote comparison: whitespace, typographic quotes/dashes, unicode form. */
export function normalizeForQuote(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„«»″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
