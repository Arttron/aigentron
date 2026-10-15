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
