/** What the usage page shows: which columns / token series are on (remembered per browser), and the pure helpers around them. */

export type StatCol = 'sessions' | 'requests' | 'inputTokens' | 'outputTokens' | 'cacheTokens' | 'estCostUsd';

export const STAT_COLS: { key: StatCol; label: string; token?: boolean }[] = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'requests', label: 'Requests' },
  { key: 'inputTokens', label: 'Input', token: true },
  { key: 'outputTokens', label: 'Output', token: true },
  { key: 'cacheTokens', label: 'Cache', token: true },
  { key: 'estCostUsd', label: 'Est. cost' },
];

const KEY = 'lds.statsHidden';

/** The columns the person switched off. Anything unknown in the stored value is ignored. */
export function parseHidden(raw: unknown): Set<StatCol> {
  const known = new Set<string>(STAT_COLS.map((c) => c.key));
  return new Set((Array.isArray(raw) ? raw : []).filter((k): k is StatCol => typeof k === 'string' && known.has(k)));
}

export function readHidden(): Set<StatCol> {
  try {
    return parseHidden(JSON.parse(window.localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

export function writeHidden(h: ReadonlySet<StatCol>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...h]));
  } catch {
    /* not remembered */
  }
}

/** Tokens of a row that are switched on (the three series the chart stacks; hidden ones do not count towards the bar either). */
export function shownTokens(u: { inputTokens: number; outputTokens: number; cacheTokens: number }, hidden: ReadonlySet<StatCol>): number {
  return (hidden.has('inputTokens') ? 0 : u.inputTokens) + (hidden.has('outputTokens') ? 0 : u.outputTokens) + (hidden.has('cacheTokens') ? 0 : u.cacheTokens);
}

/** `2026-10-22` → `22 Oct` (a day label for the chart axis and the table). */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Which of the day columns get a label on the axis: the first, the last and roughly every `step`-th in between. */
export function axisTicks(n: number, step = 7): number[] {
  if (n <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  if (out[out.length - 1] !== n - 1 && n - 1 - out[out.length - 1]! >= Math.ceil(step / 2)) out.push(n - 1);
  return out;
}
