/**
 * Pure aggregation helpers behind the admin's `metrics_report`: group, rank, percentile, and a Markdown table the chat renders as a
 * real table. No database, no I/O — the service feeds rows in, this turns them into numbers and text.
 */

export const METRIC_TOPICS = ['approvals', 'tasks', 'agents', 'config'] as const;
export type MetricTopic = (typeof METRIC_TOPICS)[number];

/** Rows with the same key counted together, biggest first. */
export function groupTop<T>(rows: readonly T[], key: (r: T) => string, top = 10): { key: string; count: number; share: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = rows.length || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([k, count]) => ({ key: k, count, share: count / total }));
}

/** The p-th percentile (0–100) of numbers, nearest-rank; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}

export const pct = (share: number): string => `${Math.round(share * 100)}%`;

/** `95` → "95 s", `3700` → "1 h 2 min", null → "—". */
export function humanSeconds(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  return `${h} h ${Math.round((sec - h * 3600) / 60)} min`;
}

/** What a free-text reason / command / error looks like with its variable parts (ids, paths, numbers) blurred, so equal things group. */
export function normalizeText(text: string, max = 90): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\b[a-z0-9]{24,}\b/gi, '<id>')
    .replace(/(?:\/[\w.@-]+){3,}/g, '<path>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .trim()
    .slice(0, max);
}

/** A Markdown table (header + rows); cells are cleaned of pipes and newlines. */
export function mdTable(head: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const cell = (v: string | number) => String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return [`| ${head.map(cell).join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** Seconds between two dates, null when either is missing. */
export function secondsBetween(a: Date | null | undefined, b: Date | null | undefined): number | null {
  return a && b ? Math.max(0, (b.getTime() - a.getTime()) / 1000) : null;
}

export function clampDays(days: unknown, fallback = 7): number {
  const n = typeof days === 'number' && Number.isFinite(days) ? Math.round(days) : fallback;
  return Math.min(365, Math.max(1, n));
}
