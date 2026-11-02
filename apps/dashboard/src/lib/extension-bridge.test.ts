import { describe, expect, it } from 'vitest';
import { INITIAL, compareVersions, extensionOutdated, reduce } from './extension-bridge';

const ready = (extra: object = {}) => ({ source: 'aigentron-extension', type: 'ready', version: '0.1.104', extensionId: 'abc', connected: false, needsReconnect: false, user: null, ...extra });

describe('extension handshake (page side)', () => {
  it('learns that the extension is there, and whether it is connected', () => {
    let s = reduce(INITIAL, ready());
    expect(s).toMatchObject({ detected: true, version: '0.1.104', connected: false });
    s = reduce(s, ready({ connected: true, user: 'Olga' }));
    expect(s).toMatchObject({ connected: true, user: 'Olga' });
    s = reduce(s, ready({ needsReconnect: true, connected: false }));
    expect(s.needsReconnect).toBe(true);
  });
  it('a refused code shows its reason; an accepted one clears it', () => {
    let s = reduce({ ...INITIAL, busy: true }, { source: 'aigentron-extension', type: 'paired', ok: false, error: 'expired' });
    expect(s).toMatchObject({ busy: false, error: 'expired' });
    s = reduce({ ...s, busy: true }, { source: 'aigentron-extension', type: 'paired', ok: true });
    expect(s).toMatchObject({ busy: false, error: null });
  });
  it('ignores anything that is not from the extension', () => {
    expect(reduce(INITIAL, { source: 'other', type: 'ready' })).toBe(INITIAL);
    expect(reduce(INITIAL, 'ready')).toBe(INITIAL);
    expect(reduce(INITIAL, null)).toBe(INITIAL);
  });
});

describe('extension version check', () => {
  it('compares numerically and ignores unknowns', () => {
    expect(compareVersions('0.1.104', '0.1.99')).toBe(1);
    expect(extensionOutdated('0.1.99', '0.1.104')).toBe(true);
    expect(extensionOutdated('0.1.104', '0.1.104')).toBe(false);
    expect(extensionOutdated(null, '0.1.104')).toBe(false);
    expect(extensionOutdated('0.1.99', 'dev')).toBe(false);
    expect(extensionOutdated('0.1.99', undefined)).toBe(false);
  });
});
