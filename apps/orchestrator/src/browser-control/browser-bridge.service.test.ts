import { describe, expect, it } from 'vitest';
import { BrowserBridgeService, type BridgeSocket } from './browser-bridge.service';

const sock = (id: string) => {
  const sent: { event: string; payload: { id: string; tool: string; args: object; taskId: string } }[] = [];
  const s: BridgeSocket & { sent: typeof sent } = { id, sent, emit: (event, payload) => void sent.push({ event, payload: payload as never }) };
  return s;
};

describe('BrowserBridgeService', () => {
  it('sends a command to the browser and resolves with its answer', async () => {
    const b = new BrowserBridgeService();
    const s = sock('s1');
    b.attach(s, 'd1', 'u1');
    const p = b.call('t1', 'snapshot', { tabId: 5 });
    expect(s.sent[0]).toMatchObject({ event: 'ext:command', payload: { tool: 'snapshot', args: { tabId: 5 }, taskId: 't1' } });
    b.onResult('s1', { id: s.sent[0]!.payload.id, ok: true, data: { text: 'hi' } });
    expect(await p).toEqual({ ok: true, data: { text: 'hi' } });
  });
  it('says so plainly when there is no browser; prefers the one the person is in front of', async () => {
    const b = new BrowserBridgeService();
    await expect(b.call('t1', 'tabs', {})).rejects.toThrow(/No browser/);
    const a = sock('a');
    const c = sock('c');
    b.attach(a, 'da', 'u1');
    b.attach(c, 'dc', 'u1');
    b.setFront('c', true);
    void b.call('t1', 'tabs', {});
    expect(c.sent).toHaveLength(1);
    expect(a.sent).toHaveLength(0);
  });
  it('only the socket a command went to can answer it; a late answer is ignored', async () => {
    const b = new BrowserBridgeService();
    const s = sock('s1');
    b.attach(s, 'd1', 'u1');
    b.attach(sock('evil'), 'd2', 'u2');
    const p = b.call('t1', 'tabs', {}, { userId: 'u1' });
    const id = s.sent[0]!.payload.id;
    b.onResult('evil', { id, ok: true, data: 'forged' });
    b.onResult('s1', { id, ok: true, data: 'real' });
    b.onResult('s1', { id, ok: true, data: 'again' });
    expect((await p).data).toBe('real');
  });
  it('times out, and a disconnect fails the waiting command', async () => {
    const b = new BrowserBridgeService();
    b.attach(sock('s1'), 'd1', 'u1');
    expect(await b.call('t1', 'tabs', {}, { timeoutMs: 20 })).toMatchObject({ ok: false, error: expect.stringContaining('did not answer') });
    const p = b.call('t1', 'tabs', {});
    b.detach('s1');
    expect(await p).toMatchObject({ ok: false, error: expect.stringContaining('disconnected') });
  });
  it('one task at a time; the lock is the browser\'s, and Stop cuts the task off', async () => {
    const b = new BrowserBridgeService();
    const s = sock('s1');
    b.attach(s, 'd1', 'u1');
    void b.call('t1', 'tabs', {});
    await expect(b.call('t2', 'tabs', {})).rejects.toThrow(/another task/);
    b.onStop('s1');
    expect(b.isStopped('t1')).toBe(true);
    await expect(b.call('t1', 'tabs', {})).rejects.toThrow(/pressed Stop/);
    // t2 may use it now (the lock went with the Stop); t1 may again after release / ten minutes
    void b.call('t2', 'tabs', {});
    b.release('t1');
    expect(b.isStopped('t1')).toBe(false);
    expect(b.isStopped('t1', Date.now() + 11 * 60_000)).toBe(false);
  });
  it('a task nobody owns does not pick between several people\'s browsers', async () => {
    const b = new BrowserBridgeService();
    b.attach(sock('s1'), 'd1', 'u1');
    b.attach(sock('s2'), 'd2', 'u2');
    await expect(b.call('t9', 'tabs', {})).rejects.toThrow();
  });
  it('allowing agents again after a Stop frees the tasks', () => {
    const b = new BrowserBridgeService();
    b.attach(sock('s1'), 'd1', 'u1');
    void b.call('t1', 'tabs', {});
    b.onStop('s1');
    expect(b.isStopped('t1')).toBe(true);
    b.onAllow('some-dashboard-socket');
    expect(b.isStopped('t1')).toBe(true); // not an extension: ignored
    b.onAllow('s1');
    expect(b.isStopped('t1')).toBe(false);
  });
  it('the Stop of a task expires after ten minutes', () => {
    const b = new BrowserBridgeService();
    b.attach(sock('s1'), 'd1', 'u1');
    void b.call('t1', 'tabs', {});
    b.onStop('s1');
    expect(b.isStopped('t1', Date.now() + 5 * 60_000)).toBe(true);
    expect(b.isStopped('t1', Date.now() + 11 * 60_000)).toBe(false);
  });
});
