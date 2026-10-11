/**
 * Addressing an agent from a chat: `/pm text` or `@pm text`. Names are matched forgivingly — case, dashes/underscores/spaces and small
 * typos (a missing, extra, wrong or swapped letter) are ignored — so "/Backend-Dev", "@bakend_dev" and "/backned_dev" all find
 * `backend-dev`. Pure logic, unit-tested.
 */

/** A name as a Telegram command: lowercase letters/digits/underscore, 1–32 chars (null when nothing usable is left). */
export function commandKey(name: string): string | null {
  const k = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/g, '');
  return k || null;
}

/** Optimal-string-alignment distance (insert / delete / replace / swap two neighbours each cost 1). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array<number>(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[m]![n]!;
}

export interface AgentRef {
  name: string;
}

export type AgentMatch =
  | { kind: 'exact'; name: string }
  | { kind: 'fuzzy'; name: string }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none'; suggestions: string[] };

const flat = (s: string) => s.replace(/_/g, '');

/** How many mistakes are forgiven for a name of this length. */
const tolerance = (len: number) => (len <= 3 ? 0 : len <= 7 ? 1 : 2);

/** Find the agent a typed name means. `exact` = spelled right (any case / separator); `fuzzy` = a typo was forgiven. */
export function matchAgent(input: string, agents: readonly AgentRef[]): AgentMatch {
  const typed = commandKey(input);
  if (!typed) return { kind: 'none', suggestions: [] };
  const keyed = agents.map((a) => ({ name: a.name, key: commandKey(a.name) ?? a.name.toLowerCase() }));

  const exact = keyed.filter((a) => a.key === typed || flat(a.key) === flat(typed) || a.name.toLowerCase() === input.trim().toLowerCase());
  if (exact.length === 1) return { kind: 'exact', name: exact[0]!.name };
  if (exact.length > 1) return { kind: 'ambiguous', names: exact.map((a) => a.name) };

  // a unique prefix ("/arch" → architect)
  if (typed.length >= 3) {
    const pre = keyed.filter((a) => a.key.startsWith(typed) || flat(a.key).startsWith(flat(typed)));
    if (pre.length === 1) return { kind: 'fuzzy', name: pre[0]!.name };
    if (pre.length > 1) return { kind: 'ambiguous', names: pre.map((a) => a.name) };
    // …or a fragment of one name ("/tutor" → English tutor, "/dev" → both developers)
    const part = keyed.filter((a) => a.key.includes(typed) || flat(a.key).includes(flat(typed)));
    if (part.length === 1) return { kind: 'fuzzy', name: part[0]!.name };
    if (part.length > 1) return { kind: 'ambiguous', names: part.map((a) => a.name) };
  }

  const scored = keyed
    .map((a) => ({ name: a.name, d: Math.min(editDistance(typed, a.key), editDistance(flat(typed), flat(a.key))) }))
    .sort((x, y) => x.d - y.d);
  const best = scored[0];
  if (best && best.d <= tolerance(flat(typed).length)) {
    const ties = scored.filter((s) => s.d === best.d);
    if (ties.length === 1) return { kind: 'fuzzy', name: best.name };
    return { kind: 'ambiguous', names: ties.map((t) => t.name) };
  }
  return { kind: 'none', suggestions: scored.filter((s) => s.d <= 3).slice(0, 3).map((s) => s.name) };
}

/** `/pm text`, `/pm@MyBot text` or `@pm text` at the start of a message → the typed name, the symbol used and the rest. */
export function parseAddress(text: string): { symbol: '/' | '@'; typed: string; rest: string } | null {
  const m = /^\s*([/@])([A-Za-z0-9][A-Za-z0-9_-]{0,39})(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  return { symbol: m[1] as '/' | '@', typed: m[2]!, rest: (m[3] ?? '').trim() };
}
