import { describe, expect, it } from 'vitest';
import { PENDING_TTL_MS, newPending, reconcilePending, visibleStarting } from './pending-messages';

describe('reconcilePending', () => {
  it('keeps a message until the server echoes it, ignoring whitespace differences', () => {
    const p = newPending('hello   world', 1000);
    expect(reconcilePending([p], [], 2000)).toEqual([p]);
    expect(reconcilePending([p], ['hello world'], 2000)).toEqual([]);
  });
  it('one echo consumes one pending message (two identical sends need two echoes)', () => {
    const a = newPending('ok', 1000);
    const b = newPending('ok', 1001);
    expect(reconcilePending([a, b], ['ok'], 2000)).toEqual([b]);
    expect(reconcilePending([a, b], ['ok', 'ok'], 2000)).toEqual([]);
  });
  it('an old message that was never echoed does not stay forever', () => {
    const p = newPending('lost', 1000);
    expect(reconcilePending([p], [], 1000 + PENDING_TTL_MS + 1)).toEqual([]);
  });
  it('earlier echoes of other text do not remove it', () => {
    const p = newPending('new one', 1000);
    expect(reconcilePending([p], ['something else'], 2000)).toEqual([p]);
  });
});

describe('visibleStarting', () => {
  const items = [
    { text: 'one', starting: true },
    { text: 'two', starting: false },
  ];
  it('shows a starting message while the task waits to start', () => {
    expect(visibleStarting(items, 'queued', ['one'])).toEqual(items);
  });
  it('once the task runs, hides a starting message the conversation has echoed, keeps the rest', () => {
    expect(visibleStarting(items, 'running', ['one'])).toEqual([items[1]]);
    expect(visibleStarting(items, 'running', ['something else'])).toEqual(items);
  });
  it('an earlier identical message does not hide a new one twice', () => {
    const two = [{ text: 'ok', starting: true }, { text: 'ok', starting: true }];
    expect(visibleStarting(two, 'running', ['ok'])).toHaveLength(1);
  });
});
