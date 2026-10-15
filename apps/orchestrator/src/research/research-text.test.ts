import { describe, expect, it } from 'vitest';
import { htmlToText, isPrivateAddress, normalizeForQuote } from './research-text';

describe('isPrivateAddress (SSRF guard)', () => {
  it.each(['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '0.0.0.0'])('blocks %s', (a) => {
    expect(isPrivateAddress(a)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (a) => {
    expect(isPrivateAddress(a)).toBe(false);
  });
});

describe('htmlToText', () => {
  it('extracts title, strips scripts/styles and decodes entities', () => {
    const r = htmlToText('<html><head><title>Hi &amp; bye</title><style>p{}</style></head><body><script>alert(1)</script><p>One &laquo;two&raquo;</p></body></html>');
    expect(r.title).toBe('Hi & bye');
    expect(r.text).toContain('One «two»');
    expect(r.text).not.toContain('alert');
    expect(r.text).not.toContain('p{}');
  });
});

describe('normalizeForQuote', () => {
  it('makes quotes comparable across whitespace/typographic-quote differences', () => {
    expect(normalizeForQuote('  Hello,\n “World” ')).toBe(normalizeForQuote('Hello, "World"'));
  });
});

describe('isPrivateAddress (SSRF, IPv6 forms that embed IPv4)', () => {
  it.each(['::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::1', '::127.0.0.1', 'fec0::1', 'fe80::1%lo0', '192.0.2.1', 'not-an-ip'])('blocks %s', (a) => {
    expect(isPrivateAddress(a)).toBe(true);
  });
});

describe('safeLookup (DNS-rebinding guard at connect time)', () => {
  it('refuses a host that resolves to loopback', async () => {
    const { safeLookup } = await import('./research-text');
    const err = await new Promise<NodeJS.ErrnoException | null>((res) => safeLookup('localhost', {}, (e) => res(e)));
    expect(err?.code).toBe('EACCES');
  });
});
