import { describe, expect, it } from 'vitest';
import { DEVICE_IDLE_DAYS, TOKEN_RE, looksLikeDeviceToken, newDevice, verifyDevice } from './extension-devices';

describe('extension device credentials', () => {
  it('a token has the shape, only a hash is kept, and it verifies', () => {
    const { record, token } = newDevice('u1', 'Chrome on macOS');
    expect(token).toMatch(TOKEN_RE);
    expect(JSON.stringify(record)).not.toContain(token.split('_')[2]);
    expect(verifyDevice([record], token)?.id).toBe(record.id);
    expect(record).toMatchObject({ userId: 'u1', label: 'Chrome on macOS' });
  });
  it('a wrong secret, a wrong id, a malformed token and an idle device are refused', () => {
    const { record, token } = newDevice('u1', 'x');
    const [, id] = token.split('_');
    expect(verifyDevice([record], `ext_${id}_${'A'.repeat(43)}`)).toBeNull();
    expect(verifyDevice([record], `ext_${'0'.repeat(16)}_${token.split('_')[2]}`)).toBeNull();
    for (const t of [undefined, '', 'ext_', 'Bearer x', token.slice(0, -1)]) expect(verifyDevice([record], t as string)).toBeNull();
    const idle = Date.now() + (DEVICE_IDLE_DAYS + 1) * 86_400_000;
    expect(verifyDevice([record], token, idle)).toBeNull();
    expect(verifyDevice([record], token, Date.now() + 86_400_000)?.id).toBe(record.id);
  });
  it('the label is cleaned and capped; two devices differ', () => {
    expect(newDevice('u', '(Chrome) on Mac').record.label).toBe('Chrome on Mac');
    expect(newDevice('u', ' ').record.label).toBe('Chromium');
    expect(newDevice('u', 'x'.repeat(200)).record.label.length).toBe(60);
    expect(newDevice('u', 'a').token).not.toBe(newDevice('u', 'a').token);
  });
  it('tells the guard which check applies', () => {
    expect(looksLikeDeviceToken('ext_abc')).toBe(true);
    expect(looksLikeDeviceToken('abc.def')).toBe(false);
    expect(looksLikeDeviceToken(undefined)).toBe(false);
  });
});
