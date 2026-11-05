// The parts of the side panel's chat that decide what the person sees (pure, unit-tested): a message just sent is shown AT ONCE ("sending…"), messages waiting in
// the server's queue are listed, and a message whose run is waiting to start is shown too — the same rules as the dashboard's chat.

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export const PENDING_TTL_MS = 5 * 60_000;
let counter = 0;

/** A message the person just sent, shown before the server has answered (and long before the conversation echoes it). */
export const newPending = (text, now = Date.now()) => ({ id: `pending-${now}-${++counter}`, text, at: now });

/**
 * Drop the pending messages the conversation has echoed (each echoed message uses up ONE pending message with the same text, so two identical messages in a row
 * both stay until both are echoed) and the ones older than the TTL.
 */
export function reconcilePending(pending, echoedTexts, now = Date.now()) {
  const left = echoedTexts.map(norm);
  const kept = [];
  for (const p of pending) {
    if (now - p.at > PENDING_TTL_MS) continue;
    const i = left.indexOf(norm(p.text));
    if (i >= 0) left.splice(i, 1);
    else kept.push(p);
  }
  return kept;
}

/**
 * What waits under the conversation, in order: queued messages (and the one whose run is waiting to start: `starting`), then the ones still being sent. A local
 * "sending…" message that is already in the server's queue is the same message. A `starting` message is shown while the task waits to start, and after that
 * only until the conversation has echoed it.
 */
export function waiting({ queue, pending, status, echoedTexts }) {
  const left = echoedTexts.map(norm);
  const shownQueue = (queue ?? []).filter((q) => {
    if (!q.starting || status === 'queued') return true;
    const i = left.indexOf(norm(q.text));
    if (i >= 0) {
      left.splice(i, 1);
      return false;
    }
    return true;
  });
  const queuedTexts = shownQueue.map((q) => norm(q.text));
  const sending = pending.filter((p) => {
    const i = queuedTexts.indexOf(norm(p.text));
    if (i >= 0) queuedTexts.splice(i, 1);
    return i < 0;
  });
  return [
    ...shownQueue.map((q) => ({ kind: q.starting ? 'starting' : 'queued', id: q.id, text: q.text })),
    ...sending.map((p) => ({ kind: 'sending', id: p.id, text: p.text })),
  ];
}
