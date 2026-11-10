import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// The parser is plain CommonJS in infra/ (it also runs inside the proxy browser's container); it is tested from here.
const { parseProxy } = createRequire(import.meta.url)('../../../../infra/proxy-parse.cjs') as { parseProxy: (s: string) => { server: string; username?: string; password?: string } };

const want = { server: 'http://res.proxy-seller.com:10000', username: 'user', password: 'pass' };

describe('parseProxy — the shapes proxy sellers hand out', () => {
  it.each([
    ['host;port;user;pass', 'res.proxy-seller.com;10000;user;pass'],
    ['host:port:user:pass', 'res.proxy-seller.com:10000:user:pass'],
    ['user:pass@host:port', 'user:pass@res.proxy-seller.com:10000'],
    ['host:port@user:pass', 'res.proxy-seller.com:10000@user:pass'],
    ['a full address', 'http://user:pass@res.proxy-seller.com:10000'],
    ['with spaces', 'res.proxy-seller.com 10000 user pass'],
    ['with tabs', 'res.proxy-seller.com\t10000\tuser\tpass'],
    ['with commas and pipes', 'res.proxy-seller.com|10000|user|pass'],
    ['login first', 'user:pass:res.proxy-seller.com:10000'],
    ['with a trailing space and a newline at the end', '  res.proxy-seller.com;10000;user;pass \n'],
  ])('%s', (_n, s) => expect(parseProxy(s)).toEqual(want));

  it('without a login', () => {
    expect(parseProxy('1.2.3.4:3128')).toEqual({ server: 'http://1.2.3.4:3128' });
    expect(parseProxy('1.2.3.4;3128')).toEqual({ server: 'http://1.2.3.4:3128' });
    expect(parseProxy('https://proxy.example.com:8443')).toEqual({ server: 'https://proxy.example.com:8443' });
  });
  it('keeps the kind of proxy (socks5, socks5h → socks5) and reads %-encoded credentials', () => {
    expect(parseProxy('socks5://u:p@h.example:1080')).toEqual({ server: 'socks5://h.example:1080', username: 'u', password: 'p' });
    expect(parseProxy('socks5h://h.example:1080').server).toBe('socks5://h.example:1080');
    expect(parseProxy('http://us%40er:p%3Ass@h.example:80')).toEqual({ server: 'http://h.example:80', username: 'us@er', password: 'p:ss' });
  });
  it('a password with @ or : survives', () => {
    expect(parseProxy('user:p@ss@h.example:80')).toEqual({ server: 'http://h.example:80', username: 'user', password: 'p@ss' });
    expect(parseProxy('h.example:80:user:pa:ss')).toEqual({ server: 'http://h.example:80', username: 'user', password: 'pa:ss' });
    expect(parseProxy('h.example;80;user;pa:ss;x'.replace(';x', ''))).toEqual({ server: 'http://h.example:80', username: 'user', password: 'pa:ss' });
  });
  it('IPv6 in a full address', () => {
    expect(parseProxy('http://u:p@[2001:db8::1]:8080')).toEqual({ server: 'http://[2001:db8::1]:8080', username: 'u', password: 'p' });
  });
  it('says what is wrong, without echoing the password', () => {
    expect(() => parseProxy('')).toThrow(/empty/);
    expect(() => parseProxy('host;99999;u;SECRET')).toThrow(/not a port/);
    expect(() => parseProxy('host;99999;u;SECRET')).toThrow(/^((?!SECRET).)*$/s);
    expect(() => parseProxy('ftp://h:21')).toThrow(/proxy kind/);
    expect(() => parseProxy('justaword')).toThrow(/parts found/);
    expect(() => parseProxy('a\nb')).toThrow(/one line/);
  });
});
