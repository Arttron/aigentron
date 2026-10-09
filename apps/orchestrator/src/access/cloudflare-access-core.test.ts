import { generateKeyPairSync, createSign, type JsonWebKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accessTokenFrom, parseAud, parseTeamDomain, tokenKid, verifyAccessJwt } from './cloudflare-access-core';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'k1' };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload: Record<string, unknown>, key = privateKey, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }): string {
  const body = `${enc(header)}.${enc(payload)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
}
const cfg = { teamDomain: 'acme.cloudflareaccess.com', aud: 'a'.repeat(64) };
const good = { iss: 'https://acme.cloudflareaccess.com', aud: [cfg.aud], exp: 2000, email: 'me@acme.com', sub: 'u1' };

describe('verifyAccessJwt', () => {
  it('accepts a valid token and returns the e-mail', () => {
    const r = verifyAccessJwt(sign(good), [jwk], cfg, 1000);
    expect(r).toMatchObject({ ok: true, email: 'me@acme.com' });
  });
  it('rejects a bad signature, wrong issuer, wrong audience, expiry and unknown key', () => {
    expect(verifyAccessJwt(sign(good, other.privateKey), [jwk], cfg, 1000)).toMatchObject({ ok: false, error: 'bad signature' });
    expect(verifyAccessJwt(sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }), [jwk], cfg, 1000)).toMatchObject({ ok: false, error: 'wrong issuer' });
    expect(verifyAccessJwt(sign({ ...good, aud: ['b'.repeat(64)] }), [jwk], cfg, 1000)).toMatchObject({ ok: false, error: 'wrong application (aud)' });
    expect(verifyAccessJwt(sign(good), [jwk], cfg, 3000)).toMatchObject({ ok: false, error: 'token expired' });
    expect(verifyAccessJwt(sign(good, privateKey, { alg: 'RS256', kid: 'nope' }), [jwk], cfg, 1000)).toMatchObject({ ok: false, error: 'unknown signing key' });
  });
  it('refuses unsigned / HS256 tokens and garbage', () => {
    expect(verifyAccessJwt(sign(good, privateKey, { alg: 'none', kid: 'k1' }), [jwk], cfg, 1000)).toMatchObject({ ok: false });
    expect(verifyAccessJwt(sign(good, privateKey, { alg: 'HS256', kid: 'k1' }), [jwk], cfg, 1000)).toMatchObject({ ok: false, error: 'unexpected algorithm' });
    expect(verifyAccessJwt('abc', [jwk], cfg, 1000)).toMatchObject({ ok: false });
  });
  it('reads the kid', () => expect(tokenKid(sign(good))).toBe('k1'));
});

describe('parsing', () => {
  it('team domain', () => {
    expect(parseTeamDomain('https://Acme.cloudflareaccess.com/')).toBe('acme.cloudflareaccess.com');
    expect(parseTeamDomain('acme.cloudflareaccess.com')).toBe('acme.cloudflareaccess.com');
    expect(parseTeamDomain('evil.example.com')).toBeNull();
    expect(parseTeamDomain('acme.cloudflareaccess.com.evil.com')).toBeNull();
    expect(parseTeamDomain('')).toBeNull();
  });
  it('aud', () => {
    expect(parseAud('a'.repeat(64))).toBe('a'.repeat(64));
    expect(parseAud('short')).toBeNull();
    expect(parseAud('has space has space has space')).toBeNull();
  });
  it('token from header or cookie', () => {
    expect(accessTokenFrom({ 'cf-access-jwt-assertion': ' tok ' })).toBe('tok');
    expect(accessTokenFrom({ cookie: 'a=1; CF_Authorization=abc%2Edef' })).toBe('abc.def');
    expect(accessTokenFrom({})).toBeNull();
  });
});
