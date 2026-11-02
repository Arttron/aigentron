// Text compression and filtering for what goes to a model (messages, tool results). Pure, no model calls: every rule is a cheap text transformation
// that can be switched on and off, and every saving is counted by rule so the Stats page can show what each one earns.

export interface CompressionRule {
  /** A name shown in Stats. */
  name: string;
  /** A regular expression (JavaScript syntax, no slashes). */
  pattern: string;
  /** What to put instead; empty removes the match. */
  replace: string;
  flags?: string;
}

export interface CompressionConfig {
  enabled: boolean;
  /** Where it applies: what a person writes to an agent, and what our own tools return (documents, knowledge base, browser pages). */
  applyToMessages: boolean;
  applyToToolResults: boolean;
  /** Texts shorter than this are left alone (nothing worth saving, and short texts are where a cut hurts). */
  minChars: number;
  /** Collapse runs of blank lines and spaces, trim line ends. */
  collapseWhitespace: boolean;
  /** `same line ×N` instead of N equal lines in a row. */
  collapseRepeatedLines: boolean;
  /** The quoted part of an e-mail reply (`> …`, `On … wrote:`), signatures (`-- `, `Sent from my …`). */
  stripQuotesAndSignatures: boolean;
  /** base64 / data: URIs / very long hex strings / very long tokens → a short placeholder with the size. */
  shortenBlobs: boolean;
  /** A long run of log or stack-trace lines: the head and the tail stay, the middle becomes `… N lines left out …`. */
  truncateLogs: boolean;
  logKeepHead: number;
  logKeepTail: number;
  /** A hard cap for one text (0 = none): the head and the tail stay. */
  maxChars: number;
  /** The person's own rules, applied last. */
  rules: CompressionRule[];
}

export const DEFAULT_COMPRESSION: CompressionConfig = {
  enabled: true,
  applyToMessages: true,
  applyToToolResults: true,
  minChars: 600,
  collapseWhitespace: true,
  collapseRepeatedLines: true,
  stripQuotesAndSignatures: true,
  shortenBlobs: true,
  truncateLogs: true,
  logKeepHead: 25,
  logKeepTail: 25,
  maxChars: 0,
  rules: [],
};

export interface CompressionResult {
  text: string;
  before: number;
  after: number;
  /** Characters removed by each rule (only the rules that removed something). */
  saved: Record<string, number>;
}

export const COMPRESSION_RULE_LABELS: Record<string, string> = {
  whitespace: 'Whitespace',
  repeats: 'Repeated lines',
  quotes: 'Quoted replies and signatures',
  blobs: 'Binary blobs',
  logs: 'Long logs',
  cap: 'Length cap',
};

/** Fills in missing / invalid fields of a stored config (it comes from JSON edited in a form). */
export function normalizeCompression(raw: unknown): CompressionConfig {
  const d = DEFAULT_COMPRESSION;
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof CompressionConfig): boolean => (typeof o[k] === 'boolean' ? (o[k] as boolean) : (d[k] as boolean));
  const int = (k: keyof CompressionConfig, max: number): number => {
    const v = Number(o[k]);
    return Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : (d[k] as number);
  };
  const rules = (Array.isArray(o.rules) ? o.rules : [])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .slice(0, 30)
    .map((r) => ({
      name: String(r.name ?? 'custom').slice(0, 60) || 'custom',
      pattern: String(r.pattern ?? '').slice(0, 500),
      replace: String(r.replace ?? '').slice(0, 500),
      flags: typeof r.flags === 'string' ? [...new Set(r.flags.replace(/[^gimsu]/g, ''))].join('') : undefined,
    }))
    .filter((r) => r.pattern)
    .map((r, i, all) => (all.findIndex((x) => x.name === r.name) === i ? r : { ...r, name: `${r.name} ${i + 1}` }));
  return {
    enabled: bool('enabled'),
    applyToMessages: bool('applyToMessages'),
    applyToToolResults: bool('applyToToolResults'),
    minChars: int('minChars', 100_000),
    collapseWhitespace: bool('collapseWhitespace'),
    collapseRepeatedLines: bool('collapseRepeatedLines'),
    stripQuotesAndSignatures: bool('stripQuotesAndSignatures'),
    shortenBlobs: bool('shortenBlobs'),
    truncateLogs: bool('truncateLogs'),
    logKeepHead: Math.max(3, int('logKeepHead', 1000)),
    logKeepTail: Math.max(3, int('logKeepTail', 1000)),
    maxChars: int('maxChars', 10_000_000),
    rules,
  };
}

/** A group that repeats AND contains a repeat — the shape of catastrophic backtracking (`(a+)+`, `(.*)*`, `(\w+\s?)*`). */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/;

/** Is a regular expression valid and cheap enough to run on every message (for the form to say so before saving)? */
export function validRulePattern(pattern: string, flags = ''): string | null {
  try {
    new RegExp(pattern, flags);
    if (NESTED_QUANTIFIER.test(pattern)) return 'a repeated group that itself repeats can freeze the server (catastrophic backtracking) — simplify it';
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'invalid pattern';
  }
}

const LOGLINE = /^\s*(?:\d{4}-\d\d-\d\d[ T]|\d\d:\d\d:\d\d|\[\d{4}-|at\s+\S+\s*\(|at\s+\S+:\d+|File ".+", line \d+|#\d+\s+0x|\w+Error:|Traceback|\^+\s*$|\[(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\]|(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\b)/;
/** A line of a log that must survive a cut: something went wrong. */
const IMPORTANT = /\b(error|fatal|exception|traceback|panic|fail(?:ed|ure|ing)?|denied|refused|timeout|timed out|segfault|assert(?:ion)?)\b/i;

function applyOne(text: string, name: string, fn: (t: string) => string, saved: Record<string, number>): string {
  const out = fn(text);
  // a filter that did not make the text shorter is thrown away (it could only have damaged it)
  if (out.length >= text.length) return text;
  saved[name] = (saved[name] ?? 0) + (text.length - out.length);
  return out;
}

/** Runs `fn` on the parts of the text that are NOT inside ``` code fences (code, tables and diffs keep every character). */
function outsideFences(text: string, fn: (t: string) => string): string {
  if (!text.includes('```')) return fn(text);
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('');
}

/** Trailing spaces after text (three or more — two are a Markdown line break) and runs of blank lines. Indentation, alignment and lines that are only spaces stay. */
const whitespace = (t: string): string =>
  t
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/(?<=\S)[ \t]{3,}$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

function repeats(t: string): string {
  const lines = t.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const n = j - i;
    if (n >= 3 && lines[i]!.trim().length >= 6) out.push(`${lines[i]} (×${n})`);
    else for (let k = i; k < j; k++) out.push(lines[k]!);
    i = j;
  }
  return out.join('\n');
}

/** Quoted lines (`> …`) are dropped only when they look like a mail reply: a run of 2+ of them, or a "wrote:" / "Original Message" header. A tail is cut only for a real mail signature. */
function quotes(t: string): string {
  const lines = t.split('\n');
  const out: string[] = [];
  let skipped = 0;
  const flush = () => {
    if (skipped) out.push(`[… ${skipped} quoted line${skipped === 1 ? '' : 's'} left out …]`);
    skipped = 0;
  };
  const quoted = (l: string | undefined): boolean => l !== undefined && /^\s*>/.test(l) && !/^\s*>\s*(\*\*|\[!)/.test(l);
  // a lone "> line" is Markdown or a shell prompt; a run of four or more is a quoted reply
  const longRun = (i: number): boolean => {
    let a = i;
    let b = i;
    while (quoted(lines[a - 1])) a--;
    while (quoted(lines[b + 1])) b++;
    return b - a + 1 >= 4;
  };
  const hasMailContext = lines.some((l) => /^\s*(On .{5,200} wrote:|Le .{5,200} a écrit\s*:|-{2,}\s*Original Message\s*-{2,})\s*$/i.test(l));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (quoted(l) && (hasMailContext || longRun(i))) {
      skipped++;
      continue;
    }
    if (/^\s*(On .{5,200} wrote:|Le .{5,200} a écrit\s*:|-{2,}\s*Original Message\s*-{2,})\s*$/i.test(l) && lines.slice(i + 1, i + 6).some((x) => /^\s*>|^\s*(From|Sent|To|Subject):/i.test(x))) {
      flush();
      skipped += lines.length - i;
      break;
    }
    // the "-- " signature separator, only with the trailing space (the standard form) and a short signature after it; "Sent from my …" mobile footers
    if ((/^-- $/.test(l) && lines.length - i <= 12) || /^\s*(Sent from my (iPhone|iPad|Android|Galaxy|phone)|Get Outlook for \w+|Отправлено с (моего )?\w+)\s*$/i.test(l)) {
      flush();
      skipped += lines.length - i;
      break;
    }
    flush();
    out.push(l);
  }
  flush();
  return out.join('\n');
}

function blobs(t: string): string {
  return t
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{80,}/gi, (m) => `[data URI, ${m.length} chars]`)
    .replace(/(?<![A-Za-z0-9+/=_.-])[A-Za-z0-9+/]{400,}={0,2}(?![A-Za-z0-9+/=_.-])/g, (m) => `[encoded data, ${m.length} chars]`)
    .replace(/\b[0-9a-f]{200,}\b/gi, (m) => `[hex string, ${m.length} chars]`);
}

/** The head and the tail of a long run of log lines stay, and so does every line that reports a problem (up to 30) — the failing line is rarely at the edge. */
function logs(t: string, head: number, tail: number): string {
  const lines = t.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!LOGLINE.test(lines[i]!)) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && (LOGLINE.test(lines[j]!) || !lines[j]!.trim())) j++;
    const run = lines.slice(i, j);
    if (run.length > head + tail + 5) {
      const middle = run.slice(head, run.length - tail);
      const keep = middle.filter((l) => IMPORTANT.test(l)).slice(0, 30);
      out.push(...run.slice(0, head), `[… ${middle.length - keep.length} log lines left out${keep.length ? '; lines that report a problem are kept' : ''} …]`, ...keep, ...run.slice(-tail));
    } else out.push(...run);
    i = j;
  }
  return out.join('\n');
}

function cap(t: string, max: number): string {
  if (max <= 0 || t.length <= max) return t;
  const keep = Math.max(200, max - 60);
  const head = Math.ceil(keep * 0.65);
  const tail = keep - head;
  return `${t.slice(0, head)}\n[… ${t.length - keep} characters left out …]\n${t.slice(t.length - tail)}`;
}

/** A custom rule never runs on a text longer than this (a pattern's cost grows with the text). */
const RULE_TEXT_LIMIT = 60_000;

/**
 * The compressed text and what each rule saved. Never throws: a broken custom rule is skipped.
 * `source`: a person's `message` gets every filter; a tool's answer (a document, a file, a transcript) only the ones that cannot damage content —
 * blobs, long logs, blank lines, the cap and the person's own rules (quotes and repeated lines are about mail and chatter, not about files).
 */
export function compressText(input: string, cfg: CompressionConfig = DEFAULT_COMPRESSION, source: 'message' | 'tool' = 'message'): CompressionResult {
  const before = input.length;
  const saved: Record<string, number> = {};
  if (!cfg.enabled || before < cfg.minChars) return { text: input, before, after: before, saved };
  const msg = source === 'message';
  let t = input;
  if (cfg.shortenBlobs) t = applyOne(t, 'blobs', (x) => outsideFences(x, blobs), saved);
  if (cfg.stripQuotesAndSignatures && msg) t = applyOne(t, 'quotes', (x) => outsideFences(x, quotes), saved);
  if (cfg.collapseWhitespace) t = applyOne(t, 'whitespace', (x) => outsideFences(x, whitespace), saved);
  if (cfg.collapseRepeatedLines && msg) t = applyOne(t, 'repeats', (x) => outsideFences(x, repeats), saved);
  if (cfg.truncateLogs) t = applyOne(t, 'logs', (x) => outsideFences(x, (y) => logs(y, cfg.logKeepHead, cfg.logKeepTail)), saved);
  if (t.length <= RULE_TEXT_LIMIT) {
    for (const r of cfg.rules) {
      if (validRulePattern(r.pattern, r.flags)) continue; // invalid or too expensive: skipped
      const re = new RegExp(r.pattern, r.flags?.includes('g') ? r.flags : `${r.flags ?? ''}g`);
      t = applyOne(t, `rule:${r.name}`, (x) => x.replace(re, r.replace), saved);
    }
  }
  if (cfg.maxChars > 0) t = applyOne(t, 'cap', (x) => cap(x, cfg.maxChars), saved);
  return { text: t, before, after: t.length, saved };
}
