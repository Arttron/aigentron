import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  base32Decode,
  base32Encode,
  hashRecovery,
  newRecoveryCodes,
  otpauthUri,
  totpCode,
  verifyTotp,
  LoginLimiter,
  clientAddress,
  ipMatches,
  isDirectLocalRequest,
  describeAgent,
  canRemovePassword,
  hashPassword,
  isLoopback,
  isThisMachine,
  isMachineRoute,
  isPublicRoute,
  parseCookies,
  signSession,
  tokenFromRequest,
  validatePassword,
  verifyPassword,
  verifySession,
} from './auth-core';

describe('passwords', () => {
  it('validates length', () => {
    expect(validatePassword('short')).toMatch(/at least/);
    expect(validatePassword('long enough!')).toBeNull();
    expect(validatePassword(123)).toMatch(/required/);
  });
  it('hashes with a random salt and verifies', () => {
    const a = hashPassword('correct horse');
    const b = hashPassword('correct horse');
    expect(a).not.toBe(b);
    expect(verifyPassword('correct horse', a)).toBe(true);
    expect(verifyPassword('wrong horse!', a)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('sessions', () => {
  const secret = 'top-secret';
  const now = 1_000_000;
  const payload = { exp: now + 1000, epoch: 3, uid: 'u1', ue: 2 };
  it('round-trips the user and enforces expiry', () => {
    const t = signSession(secret, payload);
    expect(verifySession(secret, t, now)).toEqual(payload);
    expect(verifySession(secret, t, now + 2000)).toBeNull(); // expired
  });
  it('rejects a forged or tampered token', () => {
    const t = signSession(secret, payload);
    expect(verifySession('other', t, now)).toBeNull();
    const forged = `${Buffer.from(JSON.stringify({ ...payload, uid: 'admin', exp: now + 9e9 })).toString('base64url')}.${t.split('.')[1]}`;
    expect(verifySession(secret, forged, now)).toBeNull();
    expect(verifySession(secret, `${t.split('.')[0]}.`, now)).toBeNull();
    expect(verifySession(secret, undefined, now)).toBeNull();
    expect(verifySession(secret, 'nonsense', now)).toBeNull();
  });
  it('rejects an old-format token without a user', () => {
    const old = signSession(secret, { exp: now + 1000, epoch: 1 } as never);
    expect(verifySession(secret, old, now)).toBeNull();
  });
});

describe('requests', () => {
  it('reads the cookie or a bearer header', () => {
    expect(parseCookies('a=1; lds_session=abc%3D; b=2')).toMatchObject({ lds_session: 'abc=' });
    expect(tokenFromRequest({ cookie: 'x=1; lds_session=tok' })).toBe('tok');
    expect(tokenFromRequest({ authorization: 'Bearer abc.def' })).toBe('abc.def');
    expect(tokenFromRequest({})).toBeUndefined();
  });
  it('classifies routes', () => {
    expect(isPublicRoute('/api/health')).toBe(true);
    expect(isPublicRoute('/api/tasks')).toBe(false);
    expect(isPublicRoute('/api/secret-links/abc123')).toBe(true); // the one-time token is the credential
    expect(isPublicRoute('/api/secret-linksX')).toBe(false);
    expect(isMachineRoute('/api/approvals/check')).toBe(true);
    expect(isMachineRoute('/api/approvals/abc/wait')).toBe(true);
    expect(isMachineRoute('/api/approvals/abc/decision')).toBe(false); // the human verdict is NOT a machine route
    expect(isMachineRoute('/api/approvals/abc/secret')).toBe(false);
    expect(isMachineRoute('/api/internal-mcp')).toBe(true);
    expect(isMachineRoute('/api/settings')).toBe(false);
  });
  it('recognises loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('172.18.0.5')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});

describe('isThisMachine (the hook may call us by container name)', () => {
  const own = ['127.0.0.1', '172.18.0.5', 'fe80::42:acff:fe12:5'];
  it('accepts loopback and the host\'s own addresses', () => {
    expect(isThisMachine('127.0.0.1', own)).toBe(true);
    expect(isThisMachine('::ffff:172.18.0.5', own)).toBe(true); // hook -> http://orchestrator:3001
  });
  it('refuses other containers, the docker gateway and the internet', () => {
    expect(isThisMachine('172.18.0.7', own)).toBe(false); // e.g. cloudflared or another service
    expect(isThisMachine('172.18.0.1', own)).toBe(false); // published port from the host
    expect(isThisMachine('203.0.113.9', own)).toBe(false);
    expect(isThisMachine(undefined, own)).toBe(false);
  });
});

describe('LoginLimiter', () => {
  it('locks after repeated failures and clears on success', () => {
    const l = new LoginLimiter(3);
    const t = 1000;
    l.fail('ip', t);
    l.fail('ip', t);
    expect(l.wait('ip', t)).toBe(0);
    l.fail('ip', t);
    expect(l.wait('ip', t)).toBeGreaterThan(0);
    expect(l.wait('ip', t + 60 * 60_000)).toBe(0);
    l.ok('ip');
    expect(l.wait('ip', t)).toBe(0);
    expect(l.wait('other', t)).toBe(0);
  });
});

describe('canRemovePassword', () => {
  const users = [
    { id: 'a', role: 'operator' },
    { id: 'b', role: 'reviewer' },
    { id: 'c', role: 'admin' },
  ];
  it('keeps at least one manager with a password', () => {
    expect(canRemovePassword(users, new Set(['a', 'b']), 'a')).toBe(false); // a is the only manager with a password
    expect(canRemovePassword(users, new Set(['a', 'c']), 'a')).toBe(true);
    expect(canRemovePassword(users, new Set(['a', 'b']), 'b')).toBe(true); // a reviewer may go
  });
});

describe('clientAddress', () => {
  it('believes cf-connecting-ip only from a trusted peer', () => {
    expect(clientAddress('203.0.113.7', '172.18.0.5', ['172.18.0.5'])).toBe('203.0.113.7');
    expect(clientAddress('203.0.113.7', '127.0.0.1', [])).toBe('203.0.113.7');
    expect(clientAddress('203.0.113.7', '::ffff:127.0.0.1', [])).toBe('203.0.113.7');
  });
  it('a forged header from a direct client is ignored', () => {
    expect(clientAddress('1.2.3.4', '192.168.1.50', ['172.18.0.5'])).toBe('192.168.1.50');
    expect(clientAddress('5.6.7.8', '192.168.1.50', ['172.18.0.5'])).toBe('192.168.1.50');
  });
  it('without the header the peer is the key; many users behind one tunnel stay separate', () => {
    expect(clientAddress(undefined, '172.18.0.5', ['172.18.0.5'])).toBe('172.18.0.5');
    const l = new LoginLimiter(5);
    for (let i = 0; i < 20; i++) l.fail(clientAddress('198.51.100.9', '172.18.0.5', ['172.18.0.5']), i);
    expect(l.wait(clientAddress('198.51.100.9', '172.18.0.5', ['172.18.0.5']), 30)).toBeGreaterThan(0);
    expect(l.wait(clientAddress('203.0.113.1', '172.18.0.5', ['172.18.0.5']), 30)).toBe(0);
  });
});

describe('describeAgent', () => {
  it('names common browsers and systems', () => {
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')).toBe('Chrome on macOS');
    expect(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0')).toBe('Edge on Windows');
    expect(describeAgent('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe('Firefox on Linux');
    expect(describeAgent('curl/8.4.0')).toBe('curl');
    expect(describeAgent('aigentron-cli')).toBe('Terminal (aigentron)');
    expect(describeAgent('')).toBe('Unknown device');
  });
  it('a session id in the cookie round-trips, and junk ids are dropped', () => {
    const tok = signSession('k', { exp: Date.now() + 1000, epoch: 1, uid: 'u', ue: 1, sid: 'a'.repeat(32) });
    expect(verifySession('k', tok)?.sid).toBe('a'.repeat(32));
    const bad = signSession('k', { exp: Date.now() + 1000, epoch: 1, uid: 'u', ue: 1, sid: '../../x' });
    expect(verifySession('k', bad)?.sid).toBeUndefined();
  });
});

describe('trusted proxies by CIDR (X-CF-1)', () => {
  it('matches exact addresses and CIDRs, v4 and v6, ignores garbage', () => {
    expect(ipMatches('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipMatches('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipMatches('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(ipMatches('2606:4700::1', ['2606:4700::/32'])).toBe(true);
    expect(ipMatches('1.1.1.1', ['1.1.1.1'])).toBe(true);
    expect(ipMatches('1.1.1.1', ['bogus', '1.1.1.0/99', ''])).toBe(false);
    expect(ipMatches('not-an-ip', ['0.0.0.0/0'])).toBe(false);
  });
  it('believes cf-connecting-ip from a Cloudflare edge peer, not from anyone else', () => {
    expect(clientAddress('203.0.113.7', '172.67.10.1', [])).toBe('203.0.113.7');
    expect(clientAddress('203.0.113.7', '172.67.10.1', [], false)).toBe('172.67.10.1');
    expect(clientAddress('203.0.113.7', '198.51.100.20', [])).toBe('198.51.100.20');
    expect(clientAddress('203.0.113.7', '172.18.0.9', ['172.18.0.0/16'])).toBe('203.0.113.7');
    expect(clientAddress('garbage', '127.0.0.1', [])).toBe('127.0.0.1');
  });
  it('a forwarded request from loopback is not "this machine"', () => {
    expect(isDirectLocalRequest('127.0.0.1', [], {})).toBe(true);
    expect(isDirectLocalRequest('127.0.0.1', [], { 'cf-connecting-ip': '1.2.3.4' })).toBe(false);
    expect(isDirectLocalRequest('127.0.0.1', [], { 'x-forwarded-for': '1.2.3.4' })).toBe(false);
    expect(isDirectLocalRequest('203.0.113.1', [], {})).toBe(false);
  });
});

describe('two-factor (TOTP)', () => {
  // RFC 6238 appendix B, SHA-1 seed "12345678901234567890", 6 digits (the last six of the 8-digit values)
  const seed = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC 6238 test vectors', () => {
    expect(totpCode(seed, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(seed, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpCode(seed, Math.floor(20000000000 / 30))).toBe('353130');
  });
  it('base32 round-trips', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    expect(base32Decode('mfrg gzdf')).toEqual(Buffer.from('abcde'));
  });
  it('accepts the current step and one step of drift, refuses further, refuses a repeat', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(seed, totpCode(seed, step), now)).toBe(step);
    expect(verifyTotp(seed, totpCode(seed, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(seed, totpCode(seed, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(seed, totpCode(seed, step - 2), now)).toBeNull();
    expect(verifyTotp(seed, totpCode(seed, step), now, step)).toBeNull(); // already used
    expect(verifyTotp(seed, '12345', now)).toBeNull();
    expect(verifyTotp(seed, 123456, now)).toBeNull();
    expect(verifyTotp(seed, ` ${totpCode(seed, step).slice(0, 3)} ${totpCode(seed, step).slice(3)}`, now)).toBe(step);
  });
  it('the otpauth link carries the secret and names the account', () => {
    const u = otpauthUri('ABC234', 'Ann Lee');
    expect(u).toContain('otpauth://totp/Aigentron:Ann%20Lee?secret=ABC234');
  });
  it('recovery codes: ten distinct, written with a dash, matched ignoring case and the dash', () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(hashRecovery(codes[0]!.toUpperCase().replace('-', ' '))).toBe(hashRecovery(codes[0]!));
  });
});
