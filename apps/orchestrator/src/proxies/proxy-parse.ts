/**
 * Reads a proxy written the way proxy sellers hand it out into { server, username?, password? } — the TypeScript twin of `infra/proxy-parse.cjs` (the
 * `.env` route runs that one inside the proxy browser's container); `proxy-parse.test.ts` runs both over the same lines so that they cannot drift apart.
 *   res.proxy-seller.com;10000;user;pass · user:pass@host:port · host:port@user:pass · host:port:user:pass · user:pass:host:port ·
 *   http://user:pass@host:port · host:port · fields split by ; , | tab or spaces
 */
export interface ParsedProxy {
  server: string;
  username?: string;
  password?: string;
}

const SCHEMES = ['http', 'https', 'socks5', 'socks5h', 'socks4'];

const isPort = (s: string): boolean => /^\d{1,5}$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;
const isHost = (s: string): boolean => /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(s) || /^\[[0-9A-Fa-f:.]+\]$/.test(s);

function fail(why: string): never {
  throw new Error(`cannot read this proxy: ${why}. Expected host;port;user;pass, user:pass@host:port, host:port, or a full address like http://user:pass@host:port.`);
}

function build(scheme: string, host: string, port: string, user: string, pass: string): ParsedProxy {
  if (!isHost(host)) fail(`"${host}" is not a host name or address`);
  if (!isPort(port)) fail(`"${port}" is not a port (1–65535)`);
  const s = (scheme || 'http').toLowerCase();
  const out: ParsedProxy = { server: `${s === 'socks5h' ? 'socks5' : s}://${host}:${port}` };
  if (user) out.username = user;
  if (pass) out.password = pass;
  return out;
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function parseProxy(raw: string): ParsedProxy {
  let text = String(raw ?? '').trim();
  if (!text) fail('it is empty');
  if (/[\r\n]/.test(text)) fail('give one proxy, on one line');

  const urlm = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(text);
  let scheme = '';
  if (urlm) {
    scheme = urlm[1]!.toLowerCase();
    if (!SCHEMES.includes(scheme)) fail(`"${scheme}://" is not a proxy kind (use http, https or socks5)`);
    text = urlm[2]!.replace(/\/+$/, '');
  }

  const at = text.lastIndexOf('@');
  if (at > 0) {
    const left = text.slice(0, at);
    const right = text.slice(at + 1);
    const hostPort = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/;
    const creds = (s: string): [string, string] => {
      const i = s.indexOf(':');
      return [decode(i < 0 ? s : s.slice(0, i)), i < 0 ? '' : decode(s.slice(i + 1))];
    };
    const r = hostPort.exec(right);
    if (r) {
      const [u, p] = creds(left);
      return build(scheme, r[1]!, r[2]!, u, p);
    }
    const l = hostPort.exec(left);
    if (l) {
      const [u, p] = creds(right);
      return build(scheme, l[1]!, l[2]!, u, p);
    }
    fail('no host:port next to the @');
  }

  const sep = [';', '|', '\t', ','].find((c) => text.includes(c));
  let parts: string[];
  if (sep) parts = text.split(sep).map((p) => p.trim());
  else if (/\s/.test(text)) parts = text.split(/\s+/);
  else parts = text.split(':');
  parts = parts.filter((p, i) => p !== '' || i >= 2);

  if (parts.length === 2) return build(scheme, parts[0]!, parts[1]!, '', '');
  if (parts.length === 4) {
    if (isPort(parts[1]!) && !(isPort(parts[3]!) && isHost(parts[2]!) && !isHost(parts[0]!))) return build(scheme, parts[0]!, parts[1]!, parts[2]!, parts[3]!);
    if (isPort(parts[3]!)) return build(scheme, parts[2]!, parts[3]!, parts[0]!, parts[1]!);
    if (/^\d+$/.test(parts[1]!)) fail(`"${parts[1]}" is not a port (1–65535)`);
    fail('no port number among the four parts');
  }
  if (parts.length === 3 && isPort(parts[1]!)) return build(scheme, parts[0]!, parts[1]!, parts[2]!, '');
  if (parts.length > 4 && !sep && isPort(parts[1]!)) return build(scheme, parts[0]!, parts[1]!, parts[2]!, parts.slice(3).join(':'));
  return fail(`${parts.length} parts found`);
}
