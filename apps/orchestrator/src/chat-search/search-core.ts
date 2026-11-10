/** Search in chats — pure helpers (unit-tested): what is indexed, how a query is read, snippets, and how hits are grouped and ranked. docs/chat-search.md */
import { stem, tokenize as kbTokenize } from '../knowledge/kb-core';

/**
 * The index's stems. The knowledge base cuts Cyrillic / Greek words to 5 letters, which keeps «Литва» and «Литве» apart; a conversation search wants them
 * together (and «бонус / бонусы / бонусов»), so those scripts are cut to 4 letters here; every other script uses the knowledge base's stem.
 */
export function searchStem(w: string): string {
  if (/^\d+$/.test(w)) return w;
  if (/[\u0400-\u04ff\u0370-\u03ff]/.test(w)) return w.length > 4 ? w.slice(0, 4) : w;
  return stem(w);
}
const tokenize = (text: string): string[] => kbTokenize(text, searchStem);

/** The kinds of events that are messages of a conversation (tool calls, stderr and the like are noise). */
export const SEARCHABLE_KINDS = ['prompt', 'assistant', 'result', 'discussion'] as const;
export type SearchableKind = (typeof SEARCHABLE_KINDS)[number];
export const isSearchableKind = (k: string): k is SearchableKind => (SEARCHABLE_KINDS as readonly string[]).includes(k);

/** A message with nothing to index (only short or stop words) is marked with this, so the backfill does not pick it up again. */
export const NO_WORDS = '.';

/** The most text of one message that is indexed (a pasted log must not make the index heavy). */
const MAX_INDEXED_CHARS = 20_000;

/** What `AgentEvent.searchText` holds: the message's words, stemmed, space-separated; '' for a kind that is not searched. */
export function eventSearchText(kind: string, text: string): string {
  if (!isSearchableKind(kind)) return '';
  const words = tokenize(text.slice(0, MAX_INDEXED_CHARS));
  return words.length ? [...new Set(words)].join(' ') : NO_WORDS;
}

export interface ParsedQuery {
  /** every word of the query (also those inside quotes), stemmed: all of them must be in a message */
  terms: string[];
  /** "exact phrases": checked against the original text after the index has found the candidates */
  phrases: string[];
  /** words after a minus: a message with any of them is left out */
  excluded: string[];
  /** the words as the person typed them, for marking in the text */
  raw: string[];
}

/** Plain words are AND-ed, "quotes" make an exact phrase, -word leaves a word out. */
export function parseQuery(q: string): ParsedQuery {
  const phrases: string[] = [];
  const excluded: string[] = [];
  const raw: string[] = [];
  let rest = q.replace(/"([^"]{1,200})"/g, (_m, p: string) => {
    const t = p.trim();
    if (t) phrases.push(t);
    return ' ';
  });
  rest = rest.replace(/(^|\s)-([^\s-][^\s]*)/g, (_m, _s: string, w: string) => {
    excluded.push(...tokenize(w));
    return ' ';
  });
  const terms = [...tokenize(rest)];
  for (const w of rest.split(/\s+/)) if (w) raw.push(w);
  for (const p of phrases) {
    terms.push(...tokenize(p));
    raw.push(...p.split(/\s+/).filter(Boolean));
  }
  return { terms: [...new Set(terms)], phrases, excluded: [...new Set(excluded)], raw };
}

/** A query the index can answer: at least one word. */
export const isSearchable = (p: ParsedQuery): boolean => p.terms.length > 0;

/** The text a person typed, for comparing a phrase with a message: lower case, one space between words. */
const flat = (s: string): string => s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ');

/** Whether the message holds every exact phrase of the query. */
export function hasPhrases(text: string, phrases: string[]): boolean {
  if (!phrases.length) return true;
  const f = flat(text);
  return phrases.every((p) => f.includes(flat(p)));
}

export interface Snippet {
  text: string;
  /** [start, end) offsets in `text` of the words to mark */
  marks: [number, number][];
}

const SNIPPET_CHARS = 220;

/** Where the words of the query stand in the original text: every run of letters whose stem is a query term, and every phrase. */
export function matchRanges(text: string, terms: string[], phrases: string[] = []): [number, number][] {
  const want = new Set(terms);
  const out: [number, number][] = [];
  const re = /[\p{L}\p{N}\p{M}]+/gu;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const pieces = tokenize(m[0]);
    if (pieces.some((p) => want.has(p))) out.push([m.index, m.index + m[0].length]);
  }
  const low = text.toLowerCase();
  for (const p of phrases) {
    const needle = p.toLowerCase();
    for (let i = low.indexOf(needle); i >= 0; i = low.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  // merge overlaps
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** A short piece of the original text around the first matches, with the offsets of the words to mark (relative to the piece). */
export function snippetOf(text: string, terms: string[], phrases: string[] = []): Snippet {
  return snippetFromRanges(text, matchRanges(text, terms, phrases));
}

/** The same for matches already found (a pattern search): `all` = [start, end) offsets in `text`, in order. */
export function snippetFromRanges(text: string, all: [number, number][]): Snippet {
  if (text.length <= SNIPPET_CHARS) return { text, marks: all };
  const first = all[0]?.[0] ?? 0;
  let start = Math.max(0, first - 60);
  // do not start in the middle of a word
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp >= 0 && sp < first) start = sp + 1;
  }
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  const body = text.slice(start, end);
  const lead = start > 0 ? '… ' : '';
  const tail = end < text.length ? ' …' : '';
  const shift = lead.length - start;
  const marks = all.filter(([a, b]) => a >= start && b <= end).map(([a, b]): [number, number] => [a + shift, b + shift]);
  return { text: `${lead}${body}${tail}`, marks };
}

export interface EventHit {
  eventId: string;
  /** the line's key in the dashboard's conversation (`<session id>:<seq>`), for the deep link */
  line: string;
  taskId: string;
  kind: string;
  speaker: string | null;
  at: Date;
  /** the database's rank: higher = better */
  rank: number;
  snippet: Snippet;
}

export interface TaskHits {
  taskId: string;
  score: number;
  hits: EventHit[];
}

const DAY_MS = 86_400_000;
/** Newer messages count more: half the weight after this many days. */
export const HALF_LIFE_DAYS = 60;

/** The weight of one hit: the database rank, damped by age, a little more for what a person wrote. */
export function hitScore(h: { rank: number; kind: string; at: Date }, now: number): number {
  const age = Math.max(0, now - h.at.getTime()) / DAY_MS;
  const recency = Math.pow(0.5, age / HALF_LIFE_DAYS);
  return Math.max(h.rank, 0.0001) * (0.4 + 0.6 * recency) * (h.kind === 'prompt' ? 1.25 : 1);
}

/** Groups hits by task: the task's score is its best hit plus a little for the number of hits; at most `perTask` hits are kept, best first. */
export function groupHits(hits: EventHit[], now: number, perTask = 3): TaskHits[] {
  const by = new Map<string, EventHit[]>();
  for (const h of hits) (by.get(h.taskId) ?? by.set(h.taskId, []).get(h.taskId)!).push(h);
  const out: TaskHits[] = [];
  for (const [taskId, list] of by) {
    // an agent's last message is repeated by the run's result: the same words are shown once (the better hit stays)
    const seen = new Set<string>();
    const scored = list
      .map((h) => ({ h, s: hitScore(h, now) }))
      .sort((a, b) => b.s - a.s)
      .filter(({ h }) => {
        const k = h.snippet.text.replace(/\s+/g, ' ').trim();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    const best = scored[0]!.s;
    out.push({ taskId, score: best * (1 + 0.1 * Math.min(list.length - 1, 5)), hits: scored.slice(0, perTask).map((x) => x.h) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The index's words as a query for each database: Postgres `plainto_tsquery` takes the plain words; SQLite FTS5 wants each word quoted. */
export const pgQueryText = (terms: string[]): string => terms.join(' ');
export const fts5Query = (terms: string[], excluded: string[]): string => {
  const q = (w: string) => `"${w.replace(/"/g, '""')}"`;
  const pos = terms.map(q).join(' ');
  return excluded.length ? `${pos} ${excluded.map((w) => `NOT ${q(w)}`).join(' ')}` : pos;
};

// ------------------------------------------------------------------ pattern search

/** The longest pattern accepted (the scan runs it over thousands of messages). */
export const MAX_PATTERN_CHARS = 200;

const WORD = '\\p{L}\\p{N}_';

/**
 * The pattern as the scan runs it. In JavaScript `\w`, `\W`, `\b` and `\B` only know the ASCII letters, so «лит\w+» would never match «Литве»: they are
 * rewritten to mean letters and digits of any script. Everything else is the person's own pattern.
 */
export function unicodeAware(src: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\' && i + 1 < src.length) {
      const n = src[i + 1]!;
      i++;
      if (n === 'w') out += inClass ? WORD : `[${WORD}]`;
      else if (n === 'W' && !inClass) out += `[^${WORD}]`;
      else if (n === 'b' && !inClass) out += `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
      else if (n === 'B' && !inClass) out += `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;
      else out += `\\${n}`;
      continue;
    }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    out += c;
  }
  return out;
}

/** A regular expression typed by a person: case-insensitive, Unicode; an error text when it is empty, too long or not valid. */
export function checkPattern(src: string): { ok: true } | { ok: false; error: string } {
  if (!src.trim()) return { ok: false, error: 'give a pattern.' };
  if (src.length > MAX_PATTERN_CHARS) return { ok: false, error: `the pattern is too long (max ${MAX_PATTERN_CHARS} characters).` };
  try {
    new RegExp(unicodeAware(src), 'giu');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `not a valid pattern: ${(e as Error).message.replace(/^Invalid regular expression: /, '').replace(/^\/[\s\S]*\/[a-z]*: /, '')}` };
  }
}
