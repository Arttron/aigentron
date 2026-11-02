// The extension's own copy of the browser-control site rules (checked again here: the server decides, but the browser is the last line).
// Kept identical to `apps/orchestrator/src/browser-control/browser-policy.ts` by a test.

export const DENY_HOSTS = [
  'paypal.com', 'stripe.com', 'wise.com', 'revolut.com', 'payoneer.com', 'venmo.com', 'klarna.com', 'alipay.com', 'pay.google.com', 'pay.apple.com',
  'binance.com', 'coinbase.com', 'kraken.com', 'privat24.ua', 'monobank.ua', 'sberbank.ru', 'tinkoff.ru', 'chase.com', 'bankofamerica.com',
  'wellsfargo.com', 'citi.com', 'hsbc.com', 'barclays.co.uk', 'lloydsbank.com', 'natwest.com', 'santander.com', 'n26.com', 'bunq.com',
  '1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com', 'keepersecurity.com', 'pass.proton.me',
  'accounts.google.com', 'myaccount.google.com', 'mail.google.com', 'login.microsoftonline.com', 'login.live.com', 'account.microsoft.com',
  'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'appleid.apple.com', 'id.apple.com', 'icloud.com', 'mail.yahoo.com',
  'login.yahoo.com', 'proton.me', 'protonmail.com',
  'console.aws.amazon.com', 'portal.azure.com', 'console.cloud.google.com',
];
const DENY_WORDS = /bank|paypal/i;

const isIP = (h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) && h.split('.').every((n) => +n < 256) ? 4 : h.includes(':') ? 6 : 0);

/** The host as one canonical string: lower case, no brackets, no trailing dot, an IPv4-mapped IPv6 address (`::ffff:7f00:1`) written as the IPv4 it is. */
export function canonHost(raw) {
  let h = raw.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    h = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  return dotted ? dotted[1] : h;
}

/** The port a URL really uses (default ports filled in). */
export const effectivePort = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');

/** The key a grant is kept under: the canonical host, with the port when it is not the default — `localhost:5173` is not `localhost:11434`. */
export function hostKey(u) {
  const h = canonHost(u.hostname);
  return u.port ? `${h.includes(':') ? `[${h}]` : h}:${u.port}` : h;
}

/** This machine itself, in any spelling (`localhost`, `localhost.`, `127.x`, `::1`, `0.0.0.0`, `::`, their IPv4-mapped forms). */
export function isLoopbackLike(host) {
  const h = canonHost(host);
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true;
  if (isIP(h) === 4) {
    const a = Number(h.split('.')[0]);
    return a === 127 || a === 0;
  }
  return false;
}

// ---- look-alike names (internationalised domain names written with letters of another alphabet) -------------------------------------------

const PUNY = { base: 36, tMin: 1, tMax: 26, skew: 38, damp: 700, initialBias: 72, initialN: 128 };
function adapt(delta, num, first) {
  delta = first ? Math.floor(delta / PUNY.damp) : delta >> 1;
  delta += Math.floor(delta / num);
  let k = 0;
  while (delta > ((PUNY.base - PUNY.tMin) * PUNY.tMax) >> 1) {
    delta = Math.floor(delta / (PUNY.base - PUNY.tMin));
    k += PUNY.base;
  }
  return k + Math.floor(((PUNY.base - PUNY.tMin + 1) * delta) / (delta + PUNY.skew));
}
/** One `xn--` label back to Unicode (RFC 3492); the label unchanged when it is not valid. */
export function punyDecode(label) {
  if (!label.startsWith('xn--')) return label;
  const input = label.slice(4);
  const out = [];
  let basic = input.lastIndexOf('-');
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; j++) out.push(input.charCodeAt(j));
  let n = PUNY.initialN;
  let i = 0;
  let bias = PUNY.initialBias;
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length; ) {
    const oldi = i;
    for (let w = 1, k = PUNY.base; ; k += PUNY.base) {
      if (idx >= input.length) return label;
      const c = input.charCodeAt(idx++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : PUNY.base;
      if (digit >= PUNY.base) return label;
      i += digit * w;
      const t = k <= bias ? PUNY.tMin : k >= bias + PUNY.tMax ? PUNY.tMax : k - bias;
      if (digit < t) break;
      w *= PUNY.base - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** Letters of other alphabets that look like Latin ones. */
const CONFUSABLE = {
  а: 'a', е: 'e', ё: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', к: 'k', м: 'm', т: 't', в: 'b', н: 'h',
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ɡ: 'g', ı: 'i', ɑ: 'a', ό: 'o',
};

/** The host as it LOOKS: decoded from punycode, normalised, look-alike letters turned into Latin. Equal to the host when nothing was disguised. */
export function skeleton(host) {
  const unicode = host.split('.').map(punyDecode).join('.').normalize('NFKC').toLowerCase();
  return [...unicode].map((c) => CONFUSABLE[c] ?? c).join('');
}

/** Why this address may never be given to an agent — or null. `ownOrigins`: the Aigentron server's own addresses (an agent must never drive its own dashboard). */
export function deniedReason(url, ownOrigins = []) {
  const host = canonHost(url.hostname);
  // the Aigentron server itself, however its address is written: a public name on any port, or this machine (any spelling) on a port the server uses
  const ownHosts = new Set();
  const localPorts = new Set();
  for (const o of ownOrigins) {
    try {
      const ou = new URL(o);
      const oh = canonHost(ou.hostname);
      if (isLoopbackLike(oh) || isIP(oh) !== 0) localPorts.add(effectivePort(ou));
      else ownHosts.add(oh);
      if (isIP(oh) !== 0 && !isLoopbackLike(oh)) ownHosts.add(oh); // the machine's own LAN address, any port the server uses
    } catch {
      /* not an address */
    }
  }
  if (ownHosts.has(host) && (isIP(host) === 0 || localPorts.has(effectivePort(url)))) return 'this is the Aigentron server itself — an agent cannot drive its own dashboard';
  if ((isLoopbackLike(host) || ownHosts.has(host)) && localPorts.has(effectivePort(url))) return 'this is the Aigentron server itself — an agent cannot drive its own dashboard';
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return 'a cloud metadata address';
  for (const candidate of new Set([host, skeleton(host)])) {
    const suffixHit = DENY_HOSTS.find((d) => candidate === d || candidate.endsWith(`.${d}`));
    if (suffixHit) return `${suffixHit} is on the list of sites agents never get (banks, payments, password managers, mail, identity, cloud consoles)${candidate !== host ? ' — this name only imitates it' : ''}`;
    if (DENY_WORDS.test(candidate)) return 'this looks like a bank or payment site — agents never get those';
  }
  return null;
}

/** `https://a.example.com/x` → { url, host, key } or null for anything that is not a plain http(s) address. */
export function webUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return { url, host: canonHost(url.hostname), key: hostKey(url) };
  } catch {
    return null;
  }
}

