/** Which task groups the person folded (remembered in this browser). */
const KEY = 'lds.collapsedSubtasks';

export function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function writeCollapsed(set: Set<string>): void {
  try {
    // only the most recent 300 are kept so the list never grows without bound
    localStorage.setItem(KEY, JSON.stringify([...set].slice(-300)));
  } catch {
    /* private window — the choice is just not remembered */
  }
}

/** "3 done · 1 running · 1 blocked" for a group of subtasks. */
export function statusSummary(statuses: string[]): string {
  const order = ['running', 'queued', 'needs_approval', 'review', 'blocked', 'stalled', 'failed', 'done', 'cancelled'];
  const label: Record<string, string> = { needs_approval: 'need approval', review: 'ready', queued: 'queued' };
  const n = new Map<string, number>();
  for (const s of statuses) n.set(s, (n.get(s) ?? 0) + 1);
  return order
    .filter((s) => n.has(s))
    .map((s) => `${n.get(s)} ${label[s] ?? s}`)
    .join(' · ');
}
