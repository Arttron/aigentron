import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { base32Decode, totpCode } from './auth-core';

const user = { id: 'u1', displayName: 'Ann', role: 'operator' };
function make() {
  const dir = mkdtempSync(join(tmpdir(), 'auth2fa-'));
  const users = { list: async () => [user], getRow: async () => user, defaultOperator: async () => user };
  const sessions = { newId: () => 's', record: () => undefined, isRevoked: () => false, purge: async () => undefined };
  const svc = new AuthService({ secretsDir: dir } as never, users as never, sessions as never);
  return svc;
}
const step = () => Math.floor(Date.now() / 30000);

async function enrolled() {
  const svc = make();
  await svc.setup('correct horse');
  const b = await svc.beginTwoFactor('u1', 'correct horse', 'k');
  if (!b.ok) throw new Error('begin');
  const e = svc.enableTwoFactor('u1', totpCode(b.secret, step()), 'k');
  if (!e.ok) throw new Error('enable');
  return { svc, secret: b.secret, recovery: e.recoveryCodes };
}

describe('two-factor sign-in', () => {
  it('needs the password to start, and a real code from the app to finish', async () => {
    const svc = make();
    await svc.setup('correct horse');
    expect((await svc.beginTwoFactor('u1', 'nope nope', 'k')).ok).toBe(false);
    const b = await svc.beginTwoFactor('u1', 'correct horse', 'k');
    expect(b.ok && b.uri.startsWith('otpauth://totp/')).toBe(true);
    expect(svc.twoFactorStatus('u1').enabled).toBe(false); // not active before the code
    expect(svc.enableTwoFactor('u1', '000000', 'k').ok).toBe(false);
    expect(svc.twoFactorStatus('u1').enabled).toBe(false);
  });

  it('once on, a password alone is not enough: the login asks for a code, then accepts it once', async () => {
    const { svc, secret } = await enrolled();
    expect(base32Decode(secret).length).toBe(20);
    const nothing = await svc.login('u1', 'correct horse', 'ip');
    expect(nothing).toMatchObject({ ok: false, needsCode: true, status: 401 });
    const wrong = await svc.login('u1', 'correct horse', 'ip', undefined, '123456');
    expect(wrong).toMatchObject({ ok: false, needsCode: true });
    // the step used while enabling is spent; the next one works
    const ok = await svc.login('u1', 'correct horse', 'ip', undefined, totpCode(secret, step() + 1));
    expect(ok.ok).toBe(true);
    const again = await svc.login('u1', 'correct horse', 'ip', undefined, totpCode(secret, step() + 1));
    expect(again.ok).toBe(false); // the same code twice
    expect((await svc.login('u1', 'bad password', 'ip', undefined, totpCode(secret, step() + 1))).ok).toBe(false);
  });

  it('a recovery code signs in once and is spent', async () => {
    const { svc, recovery } = await enrolled();
    expect((await svc.login('u1', 'correct horse', 'ip', undefined, recovery[0]!.toUpperCase())).ok).toBe(true);
    expect((await svc.login('u1', 'correct horse', 'ip', undefined, recovery[0])).ok).toBe(false);
    expect(svc.twoFactorStatus('u1').recoveryLeft).toBe(9);
  });

  it('changing the password or ending sessions keeps the second factor', async () => {
    const { svc } = await enrolled();
    await svc.changeOwnPassword('u1', 'correct horse', 'another horse', 'k');
    await svc.revokeUserSessions('u1');
    await svc.setUserPassword('u1', 'third horse!!');
    expect(svc.twoFactorStatus('u1').enabled).toBe(true);
  });

  it('turning it off needs the password and a code; a manager can reset it for a lost phone', async () => {
    const { svc, secret } = await enrolled();
    expect(svc.disableTwoFactor('u1', 'correct horse', '111111', 'k').ok).toBe(false);
    expect(svc.disableTwoFactor('u1', 'wrong wrong', totpCode(secret, step() + 1), 'k').ok).toBe(false);
    expect(svc.twoFactorStatus('u1').enabled).toBe(true);
    expect(svc.disableTwoFactor('u1', 'correct horse', totpCode(secret, step() + 1), 'k').ok).toBe(true);
    expect(svc.twoFactorStatus('u1').enabled).toBe(false);
    expect((await svc.login('u1', 'correct horse', 'ip')).ok).toBe(true);

    const b = await svc.beginTwoFactor('u1', 'correct horse', 'k');
    if (!b.ok) throw new Error('begin');
    svc.enableTwoFactor('u1', totpCode(b.secret, step()), 'k');
    expect((await svc.resetUserTwoFactor('u1')).ok).toBe(true);
    expect(svc.twoFactorStatus('u1').enabled).toBe(false);
    expect((await svc.resetUserTwoFactor('u1')).ok).toBe(false);
  });

  it('new recovery codes replace the old ones', async () => {
    const { svc, secret, recovery } = await enrolled();
    const r = svc.newRecoveryCodes('u1', 'correct horse', totpCode(secret, step() + 1), 'k');
    expect(r.ok && r.recoveryCodes.length).toBe(10);
    expect((await svc.login('u1', 'correct horse', 'ip', undefined, recovery[1])).ok).toBe(false);
  });
});

describe('two-factor required by a manager', () => {
  it('no session until it is set up: the first sign-in offers the setup, the first code turns it on and signs in', async () => {
    const svc = make();
    await svc.setup('correct horse');
    expect((await svc.setRequireTwoFactor('u1', true)).ok).toBe(true);
    const offer = await svc.login('u1', 'correct horse', 'ip');
    if (offer.ok || !offer.needsSetup) throw new Error('expected a setup offer');
    expect(offer.needsSetup.uri).toContain('otpauth://');
    // a retry shows the same secret (the one already scanned)
    const again = await svc.login('u1', 'correct horse', 'ip');
    expect(!again.ok && again.needsSetup?.secret).toBe(offer.needsSetup.secret);
    expect(svc.twoFactorStatus('u1').enabled).toBe(false);
    const wrong = await svc.login('u1', 'correct horse', 'ip', undefined, '000000');
    expect(wrong.ok).toBe(false);
    const ok = await svc.login('u1', 'correct horse', 'ip', undefined, totpCode(offer.needsSetup.secret, step()));
    expect(ok.ok && ok.recoveryCodes?.length).toBe(10);
    expect(svc.twoFactorStatus('u1')).toMatchObject({ enabled: true, required: true });
    // from now on an ordinary second step
    expect(await svc.login('u1', 'correct horse', 'ip')).toMatchObject({ ok: false, needsCode: true });
  });

  it('a wrong password never reveals the setup; the person cannot turn it off; a reset makes them set it up again', async () => {
    const svc = make();
    await svc.setup('correct horse');
    await svc.setRequireTwoFactor('u1', true);
    expect(await svc.login('u1', 'bad password', 'ip')).toMatchObject({ ok: false, error: 'Wrong password.' });
    const offer = await svc.login('u1', 'correct horse', 'ip');
    if (offer.ok || !offer.needsSetup) throw new Error('offer');
    await svc.login('u1', 'correct horse', 'ip', undefined, totpCode(offer.needsSetup.secret, step()));
    expect(svc.disableTwoFactor('u1', 'correct horse', totpCode(offer.needsSetup.secret, step() + 1), 'k').ok).toBe(false);
    expect(svc.twoFactorStatus('u1').enabled).toBe(true);
    await svc.resetUserTwoFactor('u1');
    expect((await svc.login('u1', 'correct horse', 'ip')).ok).toBe(false); // must set it up again
    await svc.setRequireTwoFactor('u1', false);
    expect((await svc.login('u1', 'correct horse', 'ip')).ok).toBe(true);
  });
});
