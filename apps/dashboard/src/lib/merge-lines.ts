/**
 * Merge a freshly fetched transcript with the lines the socket delivered meanwhile.
 * History keeps its order; live-only lines follow (they are newer). Dedupes by `id`
 * (`sessionId:seq`), so a line that arrives both ways is shown once and a refetch
 * after a reconnect is idempotent. Never drops a live line.
 */
export function mergeLines<T extends { id: string }>(history: readonly T[], live: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const l of history) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
  }
  for (const l of live) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
  }
  return out;
}
