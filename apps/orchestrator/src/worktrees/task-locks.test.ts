import { describe, expect, it } from 'vitest';
import { TaskLocks } from './task-locks';

describe('TaskLocks', () => {
  it('runs the work of one task one after the other, in order, even when one fails', async () => {
    const locks = new TaskLocks();
    const order: string[] = [];
    const slow = locks.run('t', async () => {
      order.push('a start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a end');
    });
    const fails = locks.run('t', async () => {
      order.push('b');
      throw new Error('boom');
    });
    const last = locks.run('t', async () => void order.push('c'));
    await slow;
    await expect(fails).rejects.toThrow('boom');
    await last;
    expect(order).toEqual(['a start', 'a end', 'b', 'c']);
  });

  it('different tasks do not wait for each other', async () => {
    const locks = new TaskLocks();
    let release!: () => void;
    const held = locks.run('one', () => new Promise<void>((r) => (release = r)));
    const other = await locks.run('two', async () => 'free');
    expect(other).toBe('free');
    release();
    await held;
  });
});
