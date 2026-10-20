/**
 * What was pasted into a chat box: terminal output, code, a diff, JSON, … — decided from the TEXT alone (the clipboard of a browser only
 * says text/plain). Pure: no DOM. The aim is the same as in GitHub / Slack / Discord / IDE chats: a pasted log or snippet should arrive as
 * a monospace block, a pasted sentence must stay a sentence. So the rule errs on the side of NOT wrapping: a block needs real signals.
 */

export type PasteKind = 'prose' | 'terminal' | 'code' | 'diff' | 'json' | 'log';
export interface PasteGuess {
  kind: PasteKind;
  /** the label of the fenced block (`bash`, `ts`, `diff`, `text`, …) */
  lang: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export const hasAnsi = (text: string): boolean => {
  ANSI.lastIndex = 0;
  return ANSI.test(text);
};

/** Colours and cursor movements out of a terminal copy (they are noise in a chat). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n');
}

const PROMPT = /^\s*(?:[\w.-]+@[\w.-]+(?::[^\s$#>]*)?\s*[$#]|PS [A-Za-z]:\\[^>]*>|[A-Za-z]:\\[^>\n]*>|[$%❯➜])\s+\S/;
const PLAIN_PROMPT = /^\s*[$#]\s+\S/;
const LOG_LINE = /^\s*(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[\d{2}:\d{2}:\d{2}\]|\d{2}:\d{2}:\d{2}[.,]\d+|\w{3} +\d+ \d{2}:\d{2}:\d{2}\s)/;
const LEVEL = /^\s*(?:\[?(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\]?[:\s]|(?:npm|pnpm|yarn) (?:ERR!|WARN|error)|error(?: TS\d+)?:|warning:|✔|✖|✓|✗|==>|>>>|\+\+\+ )/i;
const STACK = /^\s*(?:at [\w$.<>[\]\s]+\(.*:\d+:\d+\)|at .*:\d+:\d+$|File ".*", line \d+|Traceback \(most recent call last\)|Caused by: |\s+\^+$|panic: |goroutine \d+ \[)/;
const SHELL_CMD = /^\s*(?:sudo |npm |pnpm |yarn |npx |node |git |docker |kubectl |curl |wget |ls |cd |cat |grep |sed |awk |chmod |chown |mkdir |rm |cp |mv |ssh |scp |systemctl |journalctl |apt(?:-get)? |brew |pip3? |python3? |make |aigentron |echo |export |tail |head |find |df |du |ps |kill )/;

function jsonLike(text: string): boolean {
  const t = text.trim();
  if (!/^[[{]/.test(t) || !/[\]}]$/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

const LANGS: { lang: string; re: RegExp[] }[] = [
  { lang: 'ts', re: [/\b(?:interface|type)\s+\w+\s*(?:=|\{)/, /:\s*(?:string|number|boolean|unknown|void|Promise<)/, /\bimport\s+(?:type\s+)?\{?[\w\s,*]+\}?\s+from\s+['"]/, /\bexport\s+(?:default|const|function|class|interface|type)\b/, /\bas const\b|\bsatisfies\b/] },
  { lang: 'js', re: [/\b(?:const|let|var)\s+[\w{[]/, /=>\s*[{(\w]/, /\bfunction\s*\w*\s*\(/, /\brequire\(['"]/, /\bconsole\.\w+\(/, /\basync\s+function|\bawait\s+\w/] },
  { lang: 'py', re: [/^\s*def\s+\w+\(.*\)\s*(?:->\s*[\w[\], .]+)?:\s*$/m, /^\s*class\s+\w+(?:\(.*\))?:\s*$/m, /^\s*(?:from\s+[\w.]+\s+import|import\s+[\w.]+)(?:\s+as\s+\w+)?\s*$/m, /^\s*(?:if|elif|else|for|while|try|except|with)\b.*:\s*$/m, /\bself\.\w+/, /^\s*print\(/m] },
  { lang: 'bash', re: [/^#!\/(?:usr\/)?bin\/(?:env )?(?:ba|z)?sh/, /^\s*(?:if|elif)\s+\[\[?\s.*\]\]?\s*;\s*then\s*$/m, /^\s*(?:fi|esac|done)\s*$/m, /\$\{?\w+\}?/, /^\s*for\s+\w+\s+in\s+/m, /\|\s*(?:grep|awk|sed|xargs|sort|uniq|wc|head|tail)\b/] },
  { lang: 'sql', re: [/\bSELECT\b[\s\S]+\bFROM\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bCREATE\s+(?:TABLE|INDEX|VIEW)\b/i, /\bWHERE\b[\s\S]*=/i] },
  { lang: 'html', re: [/<\/?(?:div|span|p|a|ul|li|html|body|head|script|style|button|input|form|table|tr|td|img|svg|section|main|nav)\b[^>]*>/i, /<!DOCTYPE html>/i, /<\/[a-z][\w-]*>/i] },
  { lang: 'css', re: [/^[\s\w.#:>+~[\]="*-]+\{\s*$/m, /^\s*[\w-]+:\s*[^;{}]+;\s*$/m] },
  { lang: 'go', re: [/^\s*package\s+\w+\s*$/m, /\bfunc\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+\(/, /:=\s/, /\bgo\s+func\(/] },
  { lang: 'rust', re: [/\bfn\s+\w+\s*(?:<.*>)?\(/, /\blet\s+mut\s+\w+/, /\bimpl\b.*\{/, /\buse\s+[\w:]+(?:::\{.*\})?;/, /println!\(/] },
  { lang: 'java', re: [/\bpublic\s+(?:static\s+)?(?:class|void|final|interface)\b/, /\bSystem\.out\.print/, /\bimport\s+java\./, /@Override\b/] },
  { lang: 'c', re: [/#include\s*[<"][\w./]+[>"]/, /\bint\s+main\s*\(/, /\bprintf\s*\(/, /\b(?:std::|template\s*<)/] },
];

/** Structural hints that something is code, independent of the language: braces, semicolons, consistent indentation. */
function codeShape(lines: string[]): number {
  const body = lines.filter((l) => l.trim());
  if (body.length < 2) return 0;
  const n = body.length;
  const indented = body.filter((l) => /^(?:\s{2,}|\t)\S/.test(l)).length / n;
  const endings = body.filter((l) => /[;{}()[\],]\s*$/.test(l)).length / n;
  const openers = body.filter((l) => /[{([]\s*$/.test(l)).length;
  const sentences = body.filter((l) => /^[A-ZА-ЯЁ][^.!?]*[.!?]\s*$/.test(l.trim()) && l.trim().split(/\s+/).length > 4).length / n;
  let score = 0;
  if (indented >= 0.3) score += 1;
  if (endings >= 0.4) score += 1;
  if (openers >= 1 && body.some((l) => /^\s*[}\])]/.test(l))) score += 1;
  if (sentences >= 0.4) score -= 2; // prose that happens to be indented / ends with commas
  return score;
}

function langOf(text: string): { lang: string; hits: number } | null {
  let best: { lang: string; hits: number } | null = null;
  for (const { lang, re } of LANGS) {
    const hits = re.filter((r) => r.test(text)).length;
    if (hits > (best?.hits ?? 0)) best = { lang, hits };
  }
  return best;
}

/** `ts` vs `js`: typed constructs win. Both lists share keywords, so a plain `const x = 1` is `js`. */
function resolveJsTs(text: string, g: { lang: string; hits: number }): string {
  if (g.lang !== 'js' && g.lang !== 'ts') return g.lang;
  const typed = LANGS.find((l) => l.lang === 'ts')!.re.filter((r) => r.test(text)).length;
  return typed >= 1 ? 'ts' : 'js';
}

export function classifyPaste(raw: string): PasteGuess {
  const text = stripAnsi(raw).replace(/\s+$/, '');
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  const prose: PasteGuess = { kind: 'prose', lang: '' };
  if (!text.trim() || text.length > 200_000) return prose;
  // Already fenced: the person (or a tool) formatted it.
  if (/^\s*```/m.test(text)) return prose;

  const ansi = hasAnsi(raw);

  // A single line: only an explicit shell prompt counts (`$ npm i`); a bare line is a sentence or a command the person types inline.
  if (nonEmpty.length === 1) {
    if (PROMPT.test(text) || PLAIN_PROMPT.test(text)) return { kind: 'terminal', lang: 'bash' };
    if (ansi && text.length > 20) return { kind: 'log', lang: 'text' };
    return prose;
  }

  // Diff / patch.
  if (/^diff --git /m.test(text) || (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text) && /^[-+]/m.test(text)) || (/^--- \S/m.test(text) && /^\+\+\+ \S/m.test(text))) {
    return { kind: 'diff', lang: 'diff' };
  }

  // JSON.
  if (jsonLike(text)) return { kind: 'json', lang: 'json' };

  // Terminal session: prompts, commands, logs, stack traces.
  const prompts = nonEmpty.filter((l) => PROMPT.test(l) || PLAIN_PROMPT.test(l)).length;
  const logLines = nonEmpty.filter((l) => LOG_LINE.test(l) || LEVEL.test(l)).length;
  const stack = nonEmpty.filter((l) => STACK.test(l)).length;
  const cmds = nonEmpty.filter((l) => SHELL_CMD.test(l)).length;
  const n = nonEmpty.length;
  if (prompts >= 1 && (prompts / n >= 0.2 || n <= 6)) return { kind: 'terminal', lang: 'bash' };
  if (stack >= 2 || (stack >= 1 && logLines >= 1)) return { kind: 'log', lang: 'text' };
  if (logLines >= 2 && logLines / n >= 0.3) return { kind: 'log', lang: 'text' };
  if (ansi && n >= 2) return { kind: 'log', lang: 'text' };
  if (cmds >= 2 && cmds / n >= 0.6) return { kind: 'terminal', lang: 'bash' };
  // Aligned table output (ps / df / ls -l): several lines of the same columns separated by 2+ spaces.
  const columns = nonEmpty.filter((l) => /\S {2,}\S/.test(l) && !/[.!?]\s*$/.test(l)).length;
  if (n >= 3 && columns / n >= 0.8 && nonEmpty.every((l) => l.length < 200)) return { kind: 'log', lang: 'text' };

  // YAML / config: nearly every line is `key:` or `key: value` or `- item`, with nesting; prose never looks like that for 3+ lines.
  if (n >= 3) {
    const kv = nonEmpty.filter((l) => /^\s*(?:- )?[\w.\-/"']+:(?:\s+\S.*)?$/.test(l) || /^\s*-\s+\S/.test(l)).length;
    const nested = nonEmpty.some((l) => /^ {2,}\S/.test(l));
    const sentenceish = nonEmpty.filter((l) => /[.!?]\s*$/.test(l.trim()) && l.trim().split(/\s+/).length > 5).length;
    if (kv / n >= 0.8 && nested && sentenceish === 0 && nonEmpty.some((l) => /^\s*[\w.\-/"']+:/.test(l))) return { kind: 'code', lang: 'yaml' };
  }

  // Code: needs a language signature AND a code-like shape (or a very strong signature).
  const shape = codeShape(lines);
  const g = langOf(text);
  if (g) {
    const lang = resolveJsTs(text, g);
    const strong = g.hits >= 3 || (g.hits >= 2 && shape >= 1);
    // css alone is weak (any "key: value;" line looks like it): several lines and a clean shape.
    if (lang === 'css' && !(g.hits >= 2 && n >= 3 && shape >= 1)) return prose;
    // Languages whose signatures are unambiguous (two of them are enough, indentation or not): SQL, HTML, Go, Rust, Java, C, shell scripts.
    if (['sql', 'html', 'go', 'rust', 'java', 'c', 'bash'].includes(lang) && g.hits >= 2 && shape >= 0) return { kind: 'code', lang };
    if (strong && shape >= 0) return { kind: 'code', lang };
    if (g.hits >= 1 && shape >= 2) return { kind: 'code', lang };
  }
  if (shape >= 3 && n >= 3) return { kind: 'code', lang: 'text' };
  return prose;
}

/** A fence long enough that no run of backticks inside the text can close it early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** `lang` + text → a fenced Markdown block (terminal copies lose their colour codes first). */
export function toFencedBlock(text: string, lang: string): string {
  const body = stripAnsi(text).replace(/\s+$/, '').replace(/^\n+/, '');
  const f = fenceFor(body);
  return `${f}${lang}\n${body}\n${f}`;
}

/** Is the caret inside an open fenced block of `value` (an odd number of fence lines before it)? Then a paste is already code. */
export function insideFence(value: string, caret: number): boolean {
  const before = value.slice(0, caret);
  return ((before.match(/^\s*```/gm) ?? []).length & 1) === 1;
}

export interface PasteEdit {
  value: string;
  caret: number;
  kind: PasteKind;
  lang: string;
}

/**
 * The textarea after pasting `pasted` at [start, end) of `value`: wrapped in a fenced block when it looks like terminal output or code
 * (with a blank line around it when it sits inside other text), else null — let the browser paste as usual.
 */
export function smartPaste(value: string, start: number, end: number, pasted: string): PasteEdit | null {
  if (insideFence(value, start)) return null;
  const g = classifyPaste(pasted);
  if (g.kind === 'prose') return null;
  const block = toFencedBlock(pasted, g.lang);
  const before = value.slice(0, start);
  const after = value.slice(end);
  // A blank line between the block and any text around it (so it renders as a block), and the caret lands after it.
  const lead = !before.trim() ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = !after ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const head = `${before}${lead}${block}${tail}`;
  return { value: `${head}${after}`, caret: head.length, kind: g.kind, lang: g.lang };
}
