import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_POLICY, chatWait } from './chat-policy';

describe('chatWait', () => {
  it('default: the dashboard gets 10 s when someone is looking at it, nobody looking → at once', () => {
    expect(chatWait(DEFAULT_CHAT_POLICY, true)).toBe(10_000);
    expect(chatWait(DEFAULT_CHAT_POLICY, false)).toBe(0);
  });
  it('with "nobody at once" off the delay is always kept', () => {
    expect(chatWait({ delaySec: 120, nobodyAtOnce: false }, false)).toBe(120_000);
    expect(chatWait({ delaySec: 120, nobodyAtOnce: false }, true)).toBe(120_000);
  });
  it('0 = at once; -1 = never, whoever is looking', () => {
    expect(chatWait({ delaySec: 0, nobodyAtOnce: false }, true)).toBe(0);
    expect(chatWait({ delaySec: -1, nobodyAtOnce: true }, false)).toBeNull();
    expect(chatWait({ delaySec: -1, nobodyAtOnce: false }, true)).toBeNull();
  });
});
