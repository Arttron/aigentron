import { describe, expect, it } from 'vitest';
import {
  LoginLimiter,
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
