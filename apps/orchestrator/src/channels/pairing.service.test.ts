import { describe, expect, it } from 'vitest';
import { PairingService } from './pairing.service';

const e = (chatId: string, text = 'hi') => ({ chatId, userId: 'u' + chatId, userName: 'bob', text });

describe('PairingService', () => {
  it('lists an unknown chat once, answers once per 10 minutes', () => {
    const p = new PairingService();
    expect(p.record('c1', e('100'), 0).reply).toBe(true);
    expect(p.record('c1', e('100'), 60_000).reply).toBe(false);
    expect(p.list('c1', 60_000)).toHaveLength(1);
    expect(p.list('c1', 60_000)[0]).toMatchObject({ chatId: '100', attempts: 2, firstText: 'hi' });
    expect(p.record('c1', e('100'), 11 * 60_000).reply).toBe(true);
  });
  it('forgets a request after an hour', () => {
    const p = new PairingService();
    p.record('c1', e('100'), 0);
    expect(p.list('c1', 61 * 60_000)).toHaveLength(0);
  });
  it('caps the number of strangers per channel and then stays quiet', () => {
    const p = new PairingService();
    for (let i = 0; i < 20; i++) p.record('c1', e(String(i)), 0);
    expect(p.record('c1', e('999'), 0).reply).toBe(false);
    expect(p.list('c1', 0)).toHaveLength(20);
  });
  it('is per channel and can dismiss', () => {
    const p = new PairingService();
    p.record('c1', e('100'), 0);
    p.record('c2', e('100'), 0);
    expect(p.dismiss('c1', '100')).toBe(true);
    expect(p.has('c1', '100')).toBe(false);
    expect(p.has('c2', '100')).toBe(true);
  });
  it('truncates the first message', () => {
    const p = new PairingService();
    p.record('c1', { chatId: '1', userId: 'u', text: 'x'.repeat(500) }, 0);
    expect(p.list('c1', 0)[0]!.firstText!.length).toBe(80);
  });
});
