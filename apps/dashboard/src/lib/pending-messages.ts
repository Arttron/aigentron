/**
 * A message the person just sent is shown AT ONCE (before the server has even answered, and long before the agent run starts and the
 * server echoes it as a `prompt` event — on a loaded server that took many seconds). This is the small pure part: which of the
 * local "sending…" messages are still waiting for their echo.
 */
export interface PendingMessage {
  id: string;
  text: string;
  /** when it was sent (ms) — an echo that never matches (the server rewrote the text) does not stay forever */
  at: number;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const PENDING_TTL_MS = 5 * 60_000;

/**
 * Drop the pending messages that the server has echoed (each real message consumes ONE pending message with the same text, so two
 * identical messages in a row both survive until both are echoed) and the ones older than the TTL.
 */
export function reconcilePending(pending: readonly PendingMessage[], echoedTexts: readonly string[], now = Date.now()): PendingMessage[] {
  const unconsumed = echoedTexts.map(norm);
  const kept: PendingMessage[] = [];
  for (const p of pending) {
    if (now - p.at > PENDING_TTL_MS) continue;
    const i = unconsumed.indexOf(norm(p.text));
    if (i >= 0) unconsumed.splice(i, 1);
    else kept.push(p);
  }
  return kept;
}

let counter = 0;
export const newPending = (text: string, now = Date.now()): PendingMessage => ({ id: `pending-${now}-${++counter}`, text, at: now });
