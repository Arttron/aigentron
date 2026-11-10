import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { parseProxy } from './proxy-parse';

const cjs = (createRequire(import.meta.url)('../../../../infra/proxy-parse.cjs') as { parseProxy: (s: string) => unknown }).parseProxy;

const LINES = [
  'res.proxy-seller.com;10000;user;pass',
  'res.proxy-seller.com:10000:user:pass',
  'user:pass@res.proxy-seller.com:10000',
  'res.proxy-seller.com:10000@user:pass',
  'http://user:pass@res.proxy-seller.com:10000',
  'res.proxy-seller.com 10000 user pass',
  'res.proxy-seller.com|10000|user|pass',
  'user:pass:res.proxy-seller.com:10000',
  '1.2.3.4:3128',
  '1.2.3.4;3128',
  'https://proxy.example.com:8443',
  'socks5://u:p@h.example:1080',
  'http://us%40er:p%3Ass@h.example:80',
  'user:p@ss@h.example:80',
  'h.example:80:user:pa:ss',
  'http://u:p@[2001:db8::1]:8080',
  'host;99999;u;SECRET',
  '',
  'justaword',
  'ftp://h:21',
];

describe('the TypeScript parser agrees with infra/proxy-parse.cjs on every line', () => {
  it.each(LINES)('%s', (line) => {
    let a: unknown;
    let b: unknown;
    try {
      a = parseProxy(line);
    } catch (e) {
      a = `error: ${(e as Error).message}`;
    }
    try {
      b = cjs(line);
    } catch (e) {
      b = `error: ${(e as Error).message}`;
    }
    expect(a).toEqual(b);
  });
  it('reads the seller\'s line', () => {
    expect(parseProxy('res.proxy-seller.com;10000;user;pass')).toEqual({ server: 'http://res.proxy-seller.com:10000', username: 'user', password: 'pass' });
  });
});
