// Reads a proxy written the way proxy sellers hand it out, in any of the usual shapes, into what Playwright wants: { server, username?, password? }.
//   res.proxy-seller.com;10000;user;pass        host;port;user;pass   (also with : , | tab or spaces between the fields)
//   user:pass@res.proxy-seller.com:10000        login:password@host:port
//   res.proxy-seller.com:10000@user:pass        host:port@login:password
//   http://user:pass@host:10000                 a full address (http, https, socks5); login and password may be %-encoded
//   host:10000                                  no login
//   user:pass:host:10000                        the same, login first (told apart by where the port number is)
// Plain CommonJS with no dependencies: it also runs inside the proxy browser's container (infra/playwright-proxy-config.cjs) and is tested from the orchestrator.

const SCHEMES = ['http', 'https', 'socks5', 'socks5h', 'socks4'];

function isPort(s) {
  return /^\d{1,5}$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;
}

function isHost(s) {
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(s) || /^\[[0-9A-Fa-f:.]+\]$/.test(s);
}

function fail(why) {
  throw new Error(`cannot read this proxy: ${why}. Expected host;port;user;pass, user:pass@host:port, host:port, or a full address like http://user:pass@host:port.`);
}

function build(scheme, host, port, user, pass) {
  if (!isHost(host)) fail(`"${host}" is not a host name or address`);
  if (!isPort(port)) fail(`"${port}" is not a port (1–65535)`);
  const s = (scheme || 'http').toLowerCase();
  const out = { server: `${s === 'socks5h' ? 'socks5' : s}://${host}:${port}` };
  if (user) out.username = user;
  if (pass) out.password = pass;
  return out;
}

/** @param {string} raw @returns {{ server: string, username?: string, password?: string }} */
function parseProxy(raw) {
  let text = String(raw ?? '').trim();
  if (!text) fail('it is empty');
  if (/[\r\n]/.test(text)) fail('give one proxy, on one line');

  // a full address: scheme://[login[:password]@]host:port
  const urlm = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(text);
  let scheme = '';
  if (urlm) {
    scheme = urlm[1].toLowerCase();
    if (!SCHEMES.includes(scheme)) fail(`"${scheme}://" is not a proxy kind (use http, https or socks5)`);
    text = urlm[2].replace(/\/+$/, '');
  }

  // login:password@host:port  /  host:port@login:password — split on the LAST @ (a password may hold one); the side that ends in a port is the host
  const at = text.lastIndexOf('@');
  if (at > 0) {
    const left = text.slice(0, at);
    const right = text.slice(at + 1);
    const dec = (s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    const hostPort = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/;
    const r = hostPort.exec(right);
    if (r) {
      const i = left.indexOf(':');
      return build(scheme, r[1], r[2], dec(i < 0 ? left : left.slice(0, i)), i < 0 ? '' : dec(left.slice(i + 1)));
    }
    const l = hostPort.exec(left);
    if (l) {
      const i = right.indexOf(':');
      return build(scheme, l[1], l[2], dec(i < 0 ? right : right.slice(0, i)), i < 0 ? '' : dec(right.slice(i + 1)));
    }
    fail('no host:port next to the @');
  }

  // fields separated by ; , | tab or spaces (the first of these that is there decides), else colons
  const sep = [';', '|', '\t', ','].find((c) => text.includes(c));
  let parts;
  if (sep) parts = text.split(sep).map((p) => p.trim());
  else if (/\s/.test(text)) parts = text.split(/\s+/);
  else parts = text.split(':');
  parts = parts.filter((p, i) => p !== '' || i >= 2); // an empty login is allowed only as a field of its own

  if (parts.length === 2) return build(scheme, parts[0], parts[1], '', '');
  if (parts.length === 4) {
    // host;port;user;pass — or user;pass;host;port: the port number says which
    if (isPort(parts[1]) && !(isPort(parts[3]) && isHost(parts[2]) && !isHost(parts[0]))) return build(scheme, parts[0], parts[1], parts[2], parts[3]);
    if (isPort(parts[3])) return build(scheme, parts[2], parts[3], parts[0], parts[1]);
    if (/^\d+$/.test(parts[1])) fail(`"${parts[1]}" is not a port (1–65535)`);
    fail('no port number among the four parts');
  }
  if (parts.length === 3 && isPort(parts[1])) return build(scheme, parts[0], parts[1], parts[2], '');
  if (parts.length > 4 && !sep && isPort(parts[1])) {
    // host:port:user:pass where the password holds colons
    return build(scheme, parts[0], parts[1], parts[2], parts.slice(3).join(':'));
  }
  return fail(`${parts.length} parts found`);
}

module.exports = { parseProxy };
