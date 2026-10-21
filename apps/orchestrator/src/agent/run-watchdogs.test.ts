import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunDeadline } from './run-watchdogs';

describe('RunDeadline (E-02)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires after the ceiling when nobody pauses it', () => {
    const fired = vi.fn();
    const d = new RunDeadline(1000, fired);
    d.start();
    vi.advanceTimersByTime(999);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('does not count the time spent waiting for a human', () => {
    const fired = vi.fn();
    const d = new RunDeadline(1000, fired);
    d.start();
    vi.advanceTimersByTime(600);
    d.pause(); // ask_user
    vi.advanceTimersByTime(60_000); // the person takes a minute
    expect(fired).not.toHaveBeenCalled();
    expect(d.paused).toBe(true);
    d.resume();
    expect(d.waitedMs).toBe(60_000);
    vi.advanceTimersByTime(399);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('counts overlapping holds (a question and an approval) and resumes after the last one', () => {
    const fired = vi.fn();
    const d = new RunDeadline(1000, fired);
    d.start();
    d.pause();
    d.pause();
    d.resume();
    vi.advanceTimersByTime(5000);
    expect(fired).not.toHaveBeenCalled();
    d.resume();
    vi.advanceTimersByTime(1000);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('ignores a stray resume and never fires after clear()', () => {
    const fired = vi.fn();
    const d = new RunDeadline(1000, fired);
    d.start();
    d.resume(); // no hold to release
    expect(d.paused).toBe(false);
    d.clear();
    vi.advanceTimersByTime(5000);
    expect(fired).not.toHaveBeenCalled();
  });

  it('a hold taken before start() delays arming until it is released', () => {
    const fired = vi.fn();
    const d = new RunDeadline(1000, fired);
    d.pause();
    d.start();
    vi.advanceTimersByTime(5000);
    expect(fired).not.toHaveBeenCalled();
    d.resume();
    vi.advanceTimersByTime(1000);
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('RunDeadline — extension while the run is alive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is asked when the window runs out, grants more, and expires when told no', async () => {
    const fired = vi.fn();
    const answers = [500, 0];
    const d = new RunDeadline(1000, fired, Date.now, () => answers.shift() ?? 0);
    d.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).not.toHaveBeenCalled();
    expect(d.grantedMs).toBe(1500);
    await vi.advanceTimersByTimeAsync(499);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });
  it('waits for an asynchronous answer (a person is asked) before it extends or expires', async () => {
    const fired = vi.fn();
    const asks: ((n: number) => void)[] = [];
    const d = new RunDeadline(1000, fired, Date.now, () => new Promise<number>((r) => asks.push(r)));
    d.start();
    await vi.advanceTimersByTimeAsync(5000); // the window ran out long ago; the question is still open
    expect(fired).not.toHaveBeenCalled();
    expect(asks).toHaveLength(1);
    asks[0]!(2000);
    await flush(); // let the answer through
    await vi.advanceTimersByTimeAsync(1999);
    expect(asks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // the granted time is used up: asked again
    expect(asks).toHaveLength(2);
    expect(fired).not.toHaveBeenCalled();
    asks[1]!(0); // refused
    await flush();
    expect(fired).toHaveBeenCalledTimes(1);
    expect(d.grantedMs).toBe(3000);
  });
  it('a refusal expires it; a failing decision counts as a refusal', async () => {
    const f1 = vi.fn();
    new RunDeadline(100, f1, Date.now, async () => 0).start();
    const f2 = vi.fn();
    new RunDeadline(100, f2, Date.now, async () => {
      throw new Error('x');
    }).start();
    await vi.advanceTimersByTimeAsync(200);
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).toHaveBeenCalledTimes(1);
  });
  it('an approval that holds the clock while the question is open does not break the grant', async () => {
    const fired = vi.fn();
    const asks: ((n: number) => void)[] = [];
    const d = new RunDeadline(1000, fired, Date.now, () => new Promise<number>((r) => asks.push(r)));
    d.start();
    await vi.advanceTimersByTimeAsync(1000);
    d.pause(); // the approval card of the question itself holds the clock
    asks[0]!(500);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asks).toHaveLength(1); // the clock is held: no new window yet
    d.resume(); // approved: 500 ms of active time remain
    await vi.advanceTimersByTimeAsync(499);
    expect(asks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(asks).toHaveLength(2);
    asks[1]!(0);
    await flush();
    expect(fired).toHaveBeenCalledTimes(1);
  });
  it('without a decision function it behaves as before', () => {
    const fired = vi.fn();
    new RunDeadline(1000, fired).start();
    expect(fired).not.toHaveBeenCalled();
  });
});
