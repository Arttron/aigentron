import { describe, expect, it } from 'vitest';
import { DENY_HOSTS, deniedReason, hostsOf, isLocalHost, mcpWithBrowser, parseWebUrl, searchUrl } from './browser-policy';

const denied = (u: string, own: string[] = []) => deniedReason(new URL(u), own);

describe('which addresses can be given to an agent', () => {
  it('parses web addresses and refuses the rest', () => {
    expect(parseWebUrl('https://Example.com/a?b=1')).toMatchObject({ ok: true, host: 'example.com' });
    for (const bad of ['', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'ftp://x.io', 'https://user:pw@example.com', 42, null]) {
      expect(parseWebUrl(bad as never).ok, String(bad)).toBe(false);
    }
  });
  it('banks, payments, password managers, mail, identity and consoles are never allowed — also their subdomains', () => {
    for (const u of ['https://paypal.com/x', 'https://www.paypal.com', 'https://checkout.stripe.com/pay', 'https://vault.bitwarden.com', 'https://accounts.google.com/signin', 'https://mail.google.com/mail', 'https://console.aws.amazon.com', 'https://login.microsoftonline.com']) {
      expect(denied(u), u).toBeTruthy();
    }
    // a look-alike that merely ends the same is NOT a subdomain
    expect(denied('https://notpaypal.example.org/x')).toBeTruthy(); // …but the word rule catches it
    expect(denied('https://evilstripe.com')).toBeNull();
    expect(denied('https://example.com')).toBeNull();
    expect(denied('https://github.com/anthropics')).toBeNull();
  });
  it('the word rule catches banks whatever their name', () => {
    expect(denied('https://mybank.example.com')).toContain('bank or payment');
    expect(denied('https://ebanking.example.org')).toBeTruthy();
    expect(denied('https://secure-paypal.example.net')).toBeTruthy();
  });
  it('the Aigentron server itself and cloud metadata are closed', () => {
    expect(denied('http://localhost:3088/settings', ['http://localhost:3088', 'http://localhost:3011'])).toContain('Aigentron server');
    expect(denied('http://localhost:3000/app', ['http://localhost:3088'])).toBeNull(); // the person's own dev server on another port is fine (with a grant)
    expect(denied('http://169.254.169.254/latest/meta-data')).toContain('metadata');
  });
  it('local-network addresses are recognised (they need a clearly worded grant)', () => {
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.10', '169.254.1.1', '[::1]'.slice(1, -1), 'router', 'nas.local', 'x.internal']) expect(isLocalHost(h), h).toBe(true);
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '203.0.113.9', 'sub.example.co.uk']) expect(isLocalHost(h), h).toBe(false);
  });
  it('the list is not empty and lower-case', () => {
    expect(DENY_HOSTS.length).toBeGreaterThan(40);
    for (const h of DENY_HOSTS) expect(h).toBe(h.toLowerCase());
    expect(hostsOf(['https://a.example.com:8443', 'bad', 'http://localhost:3011'])).toEqual(['a.example.com', 'localhost']);
  });
  it('search addresses', () => {
    expect(searchUrl('how to fix & test')).toBe('https://duckduckgo.com/?q=how%20to%20fix%20%26%20test');
    expect(searchUrl('x', 'google')).toContain('google.com/search?q=x');
    expect(searchUrl('x', 'unknown')).toContain('duckduckgo.com');
  });
});

describe('agents get the browser automatically', () => {
  const base = { available: true, isAdmin: false, discussion: false };
  it('adds browser-ext once when control is available', () => {
    expect(mcpWithBrowser(['github'], base)).toEqual(['github', 'browser-ext']);
    expect(mcpWithBrowser([], base)).toEqual(['browser-ext']);
    expect(mcpWithBrowser(['browser-ext', 'github'], base)).toEqual(['browser-ext', 'github']);
  });
  it('not without a paired extension, switched off, for the admin or a discussion turn', () => {
    expect(mcpWithBrowser(['github'], { ...base, available: false })).toEqual(['github']);
    expect(mcpWithBrowser([], { ...base, isAdmin: true })).toEqual([]);
    expect(mcpWithBrowser([], { ...base, discussion: true })).toEqual([]);
  });
});

describe('the same address written another way', () => {
  const own = ['https://aig.example.com', 'http://localhost:3088'];
  it('this machine in any spelling, on a port the server uses, is the server itself', () => {
    for (const u of ['http://localhost:3088/', 'http://localhost.:3088/', 'http://127.0.0.1:3088/', 'http://0.0.0.0:3088/', 'http://[::1]:3088/', 'http://[::ffff:7f00:1]:3088/', 'https://aig.example.com:444/']) {
      expect(denied(u, own), u).toMatch(/Aigentron server itself/);
    }
    expect(denied('http://localhost:5173/', own)).toBeNull();
  });
  it('the cloud metadata address, also as a mapped IPv6 address', () => {
    expect(denied('http://[::ffff:a9fe:a9fe]/')).toMatch(/metadata/);
  });
  it('a look-alike name (letters of another alphabet) is the site it imitates', () => {
    expect(denied('https://xn--pypal-4ve.com/')).toMatch(/imitates/);
    expect(denied('https://example.com/')).toBeNull();
  });
  it('a grant is kept per host and port', () => {
    const a = parseWebUrl('http://localhost:5173/');
    const b = parseWebUrl('https://Example.com/');
    expect(a.ok && a.key).toBe('localhost:5173');
    expect(b.ok && b.key).toBe('example.com');
  });
});
