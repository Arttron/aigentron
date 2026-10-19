import { describe, expect, it } from 'vitest';
import { KeyedMutex } from './project-mutex';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('KeyedMutex', () => {
  it('serialises holders of one key in FIFO order', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const r1 = await m.acquire('p');
    order.push('1 in');
    const two = m.acquire('p').then((r) => {
      order.push('2 in');
      return r;
    });
    const three = m.acquire('p').then((r) => {
      order.push('3 in');
      return r;
    });
    await tick();
    expect(order).toEqual(['1 in']);
    expect(m.pending('p')).toBe(3);
    r1();
    const r2 = await two;
    await tick();
    expect(order).toEqual(['1 in', '2 in']);
    r2();
    const r3 = await three;
    expect(order).toEqual(['1 in', '2 in', '3 in']);
    r3();
    expect(m.busy('p')).toBe(false);
    expect(m.pending('p')).toBe(0);
  });

  it('different keys never wait for each other', async () => {
    const m = new KeyedMutex();
    const waited: string[] = [];
    const ra = await m.acquire('a', () => void waited.push('a'));
    const rb = await m.acquire('b', () => void waited.push('b'));
    expect(waited).toEqual([]);
    expect(m.busy('a') && m.busy('b')).toBe(true);
    ra();
    rb();
    expect(m.busy('a') || m.busy('b')).toBe(false);
  });

  it('onWait runs only when there is something to wait for, and its cleanup once the key is taken', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const r1 = await m.acquire('p', () => void log.push('wait 1'));
    expect(log).toEqual([]);
    const second = m.acquire('p', () => {
      log.push('wait 2');
      return () => log.push('done waiting 2');
    });
    await tick();
    expect(log).toEqual(['wait 2']);
    r1();
    const r2 = await second;
    expect(log).toEqual(['wait 2', 'done waiting 2']);
    r2();
  });

  it('release is idempotent and the key is reusable afterwards', async () => {
    const m = new KeyedMutex();
    const r = await m.acquire('p');
    r();
    r();
    expect(m.pending('p')).toBe(0);
    const again = await m.acquire('p', () => {
      throw new Error('must not wait');
    });
    again();
  });
});
