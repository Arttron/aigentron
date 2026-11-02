// The conversation of a task as the side panel shows it (pure helpers — unit-tested).

/** Kinds that are somebody speaking: the person's message, the agent's words and answer, a discussion turn, a subtask's report. Tool calls and system lines are not. */
const SPEECH = new Set(['prompt', 'assistant', 'result', 'discussion', 'subtask_report']);

const roleOf = (kind) => (kind === 'prompt' ? 'you' : kind === 'result' ? 'result' : 'agent');

/**
 * Transcript events (`GET /tasks/:id/transcript`, or live `agent:log` events) → messages. An agent's earlier long message that the final answer begins with
 * is dropped (the server puts the answer in front of a short closing line, so it would show twice).
 */
export function toMessages(events) {
  const msgs = [];
  const seen = new Set();
  for (const e of events) {
    const text = String(e.text ?? '').trim();
    if (!SPEECH.has(e.kind) || !text) continue;
    const key = `${e.kind}:${e.seq ?? ''}:${text.length}:${text.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    msgs.push({ id: e.id ?? key, role: roleOf(e.kind), speaker: e.speaker ?? null, text, at: e.createdAt ?? e.ts ?? '' });
  }
  return msgs.filter((m, i) => {
    if (m.role !== 'agent' || m.text.length < 400) return true;
    const next = msgs.slice(i + 1).find((x) => x.role !== 'agent' || x.role === 'result');
    return !(next && next.role === 'result' && next.text.startsWith(m.text));
  });
}

/** A status as a short label and a tone for the chip. */
export function statusChip(status) {
  const map = {
    queued: ['queued', 'muted'],
    running: ['running', 'blue'],
    needs_approval: ['waiting for you', 'amber'],
    review: ['ready — confirm', 'green'],
    done: ['done', 'green'],
    blocked: ['blocked', 'amber'],
    stalled: ['stalled', 'amber'],
    failed: ['failed', 'red'],
    cancelled: ['cancelled', 'muted'],
  };
  const [label, tone] = map[status] ?? [String(status ?? '?'), 'muted'];
  return { label, tone };
}

/** `5 min ago`, `yesterday`, … for a date string; '' when it is not a date. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return `${Math.round(s / 86400)} days ago`;
}

/** The tasks the panel lists first: those that need the person, then the ones running, then the rest by recency. */
export function sortTasks(items) {
  const rank = (t) => (['needs_approval', 'blocked', 'review', 'stalled', 'failed'].includes(t.status) ? 0 : ['running', 'queued'].includes(t.status) ? 1 : 2);
  return [...items].sort((a, b) => rank(a) - rank(b) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}
