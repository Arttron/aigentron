/**
 * When a request that waits for a person — an approval, a question, a task that needs input — and has no chat of its own is announced in the chats.
 * The dashboard (and the browser extension) hear first; the chats hear after `delaySec` if it is still open. Pure, so the rule is tested without a clock.
 */
export interface ChatPolicy {
  /** seconds to wait; 0 = at once; -1 = never (only the chat a task came from is asked) */
  delaySec: number;
  /** nobody is looking at the dashboard: send at once instead of waiting */
  nobodyAtOnce: boolean;
}

export const DEFAULT_CHAT_POLICY: ChatPolicy = { delaySec: 10, nobodyAtOnce: true };

/** Milliseconds to wait before the chats are told: 0 = now, null = never. */
export function chatWait(p: ChatPolicy, someoneAtDashboard: boolean): number | null {
  if (p.delaySec < 0) return null;
  if (!someoneAtDashboard && p.nobodyAtOnce) return 0;
  return Math.max(0, p.delaySec) * 1000;
}
