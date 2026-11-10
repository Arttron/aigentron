/** Search in chats — pure helpers for the page (unit-tested). */

export interface Piece {
  text: string;
  mark: boolean;
}

/** A snippet cut into pieces: the words the search matched are marked. Offsets are the server's (UTF-16 units of the snippet). */
export function markPieces(text: string, marks: [number, number][]): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const [a, b] of [...marks].sort((x, y) => x[0] - y[0])) {
    if (a < at || b > text.length || a >= b) continue; // overlapping or out of range: ignored, never a crash
    if (a > at) out.push({ text: text.slice(at, a), mark: false });
    out.push({ text: text.slice(a, b), mark: true });
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

export type DateRange = 'any' | '7' | '30' | '365';
export const DATE_RANGES: { value: DateRange; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '365', label: 'Last year' },
];

/** The `from` date (YYYY-MM-DD, local) a range stands for; undefined for "any time". */
export function rangeFrom(range: DateRange, now: Date = new Date()): string | undefined {
  if (range === 'any') return undefined;
  const d = new Date(now.getTime() - Number(range) * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Who said it, for the label of a snippet. */
export function speakerLabel(h: { kind: string; speaker: string | null }): string {
  if (h.kind === 'prompt') return 'you';
  if (h.kind === 'discussion') return h.speaker || 'discussion';
  return h.kind === 'result' ? 'result' : 'agent';
}

/** The link that opens a task at a message (`line` = the conversation line's key from the search). */
export const taskAtMessage = (taskId: string, line: string): string => `/tasks/${encodeURIComponent(taskId)}?ev=${encodeURIComponent(line)}`;
