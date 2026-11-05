/**
 * Formatting of the message the person is typing, as pure text edits: a text and a selection go in, a text and a selection come out. The composer keeps
 * Markdown as the text (what agents read, and what the conversation shows formatted), and these functions are what the toolbar buttons and the shortcuts do.
 */
export interface Edit {
  text: string;
  /** selection start / end (the caret when equal) */
  start: number;
  end: number;
}

export type FormatAction = 'bold' | 'italic' | 'strike' | 'code' | 'codeblock' | 'link' | 'ul' | 'ol' | 'quote';

const MARK: Record<'bold' | 'italic' | 'strike' | 'code', string> = { bold: '**', italic: '*', strike: '~~', code: '`' };

/** Wrap the selection in `mark` (or take the mark off when the selection is already wrapped in it). With no selection the marks go in and the caret between them. */
export function toggleWrap(e: Edit, mark: string): Edit {
  const { text, start, end } = e;
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  // the marks are just outside the selection
  if (before.endsWith(mark) && after.startsWith(mark) && !(mark === '*' && (before.endsWith('**') || after.startsWith('**')))) {
    return { text: before.slice(0, -mark.length) + sel + after.slice(mark.length), start: start - mark.length, end: end - mark.length };
  }
  // several marked parts inside the selection (`**a** and **b**`): a click takes all of them off, rather than turning the words between them into bold
  if (mark !== '*') {
    const n = sel.split(mark).length - 1;
    if (n >= 4 || (n >= 2 && !(sel.startsWith(mark) && sel.endsWith(mark)))) {
      const plain = sel.split(mark).join('');
      return { text: before + plain + after, start, end: start + plain.length };
    }
  }
  // the marks are inside the selection
  if (sel.length >= mark.length * 2 && sel.startsWith(mark) && sel.endsWith(mark) && !(mark === '*' && sel.startsWith('**'))) {
    const inner = sel.slice(mark.length, sel.length - mark.length);
    return { text: before + inner + after, start, end: start + inner.length };
  }
  if (start === end) return { text: before + mark + mark + after, start: start + mark.length, end: start + mark.length };
  // keep a trailing space out of the marks: "**word **" is not bold
  const lead = /^\s*/.exec(sel)![0];
  const trail = /\s*$/.exec(sel.slice(lead.length))![0];
  const core = sel.slice(lead.length, sel.length - trail.length);
  if (!core) return { text: before + mark + mark + sel + after, start: start + mark.length, end: start + mark.length };
  return { text: before + lead + mark + core + mark + trail + after, start: start + lead.length + mark.length, end: start + lead.length + mark.length + core.length };
}

/** The lines the selection touches: [from, to) offsets in the text. */
function lineRange(text: string, start: number, end: number): { from: number; to: number } {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  // a selection that ends right after a newline does not touch the next line
  const endAt = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', endAt);
  return { from, to: nl === -1 ? text.length : nl };
}

const PREFIX: Record<'ul' | 'ol' | 'quote', RegExp> = { ul: /^(\s*)[-*]\s+/, ol: /^(\s*)\d+[.)]\s+/, quote: /^(\s*)>\s?/ };

/** Turn the touched lines into a bulleted / numbered list / quote, or back into plain lines when they all already are one. */
export function toggleLinePrefix(e: Edit, kind: 'ul' | 'ol' | 'quote'): Edit {
  const { text, start, end } = e;
  const { from, to } = lineRange(text, start, end);
  const lines = text.slice(from, to).split('\n');
  const all = lines.every((l) => !l.trim() || PREFIX[kind].test(l));
  const anyText = lines.some((l) => l.trim());
  let n = 0;
  const out = lines.map((l) => {
    if (!l.trim() && lines.length > 1) return l;
    if (all && anyText) return l.replace(PREFIX[kind], '$1');
    // another kind of prefix is replaced, not stacked
    const bare = l.replace(PREFIX.ul, '$1').replace(PREFIX.ol, '$1').replace(PREFIX.quote, '$1');
    n++;
    return kind === 'ul' ? `- ${bare}` : kind === 'ol' ? `${n}. ${bare}` : `> ${bare}`;
  });
  const replaced = out.join('\n');
  const delta = replaced.length - (to - from);
  const firstDelta = out[0]!.length - lines[0]!.length;
  const nextStart = Math.max(from, start + firstDelta);
  return { text: text.slice(0, from) + replaced + text.slice(to), start: nextStart, end: Math.max(nextStart, end + delta) };
}

/** A code block: the selection (or an empty block) between ``` lines. */
export function toggleCodeBlock(e: Edit): Edit {
  const { text, start, end } = e;
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  // already a fenced block: take the fences off
  const m = /^```[\w+#.-]*\n([\s\S]*?)\n?```$/.exec(sel);
  if (m) return { text: before + m[1] + after, start, end: start + m[1]!.length };
  const needNlBefore = before && !before.endsWith('\n') ? '\n' : '';
  const needNlAfter = after && !after.startsWith('\n') ? '\n' : '';
  const open = `${needNlBefore}\`\`\`\n`;
  const close = `\n\`\`\`${needNlAfter}`;
  const at = before.length + open.length;
  return { text: before + open + sel + close + after, start: at, end: at + sel.length };
}

/** The selection becomes a link text: `[sel](url)`; with no address yet, the placeholder `url` is selected so it can be typed over. */
export function insertLink(e: Edit, url?: string): Edit {
  const { text, start, end } = e;
  const sel = text.slice(start, end);
  const label = sel || 'link';
  const target = url ?? 'url';
  const out = `[${label}](${target})`;
  const next = text.slice(0, start) + out + text.slice(end);
  if (url !== undefined) return { text: next, start: start + out.length, end: start + out.length };
  const urlStart = start + 1 + label.length + 2;
  return { text: next, start: urlStart, end: urlStart + target.length };
}

/** Pasting an address over a selected word makes the word the link's text (what Slack does). Null when it does not apply. */
export function pasteLinkOverSelection(e: Edit, clip: string): Edit | null {
  const url = clip.trim();
  if (e.start === e.end || !/^https?:\/\/\S+$/i.test(url)) return null;
  if (/\n/.test(e.text.slice(e.start, e.end))) return null;
  return insertLink(e, url);
}

/** Shift+Enter inside a list / quote: the next line starts with the next marker; on an empty item the marker goes away (the list ends). Null when the caret is not in one. */
export function continueList(e: Edit): Edit | null {
  if (e.start !== e.end) return null;
  const { text, start } = e;
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const line = text.slice(from, start);
  const ul = /^(\s*)([-*])\s+(.*)$/.exec(line);
  const ol = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
  const q = /^(\s*)>\s?(.*)$/.exec(line);
  const m = ul ?? ol ?? q;
  if (!m) return null;
  const content = ul ? ul[3]! : ol ? ol[4]! : q![2]!;
  if (!content.trim()) {
    // an empty marker with text after the caret (`- |rest`): not the end of a list — an ordinary new line
    const nlAt = text.indexOf('\n', start);
    if (text.slice(start, nlAt === -1 ? text.length : nlAt).trim()) return null;
    // an empty item: leave the list
    return { text: text.slice(0, from) + text.slice(start), start: from, end: from };
  }
  const marker = ul ? `${ul[1]}${ul[2]} ` : ol ? `${ol[1]}${Number(ol[2]) + 1}${ol[3]} ` : `${q![1]}> `;
  const ins = `\n${marker}`;
  return { text: text.slice(0, start) + ins + text.slice(start), start: start + ins.length, end: start + ins.length };
}

/** Apply a toolbar / shortcut action. */
export function applyFormat(e: Edit, action: FormatAction): Edit {
  switch (action) {
    case 'bold':
    case 'italic':
    case 'strike':
    case 'code':
      return toggleWrap(e, MARK[action]);
    case 'codeblock':
      return toggleCodeBlock(e);
    case 'link':
      return insertLink(e);
    default:
      return toggleLinePrefix(e, action);
  }
}

/** The action a key combination stands for (⌘/Ctrl is the "mod" key), or null. Mirrors Slack's: B, I, Shift+X, K, Shift+C, Shift+7 / 8 / 9, Alt+Shift+C. */
export function shortcutAction(k: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): FormatAction | null {
  if (!(k.metaKey || k.ctrlKey)) return null;
  const key = k.key.toLowerCase();
  if (!k.shiftKey && !k.altKey) {
    if (key === 'b') return 'bold';
    if (key === 'i') return 'italic';
    if (key === 'k') return 'link';
    return null;
  }
  if (k.shiftKey && !k.altKey) {
    if (key === 'x') return 'strike';
    if (key === 'c') return 'code';
    const digit = k.code ?? '';
    if (digit === 'Digit7' || key === '7' || key === '&') return 'ol';
    if (digit === 'Digit8' || key === '8' || key === '*') return 'ul';
    if (digit === 'Digit9' || key === '9' || key === '(') return 'quote';
    return null;
  }
  if (k.shiftKey && k.altKey && (key === 'c' || k.code === 'KeyC')) return 'codeblock';
  return null;
}

/**
 * The smallest replacement that turns `before` into `after`: [from, to) of the old text and the text that goes there. It lets the composer change only
 * what changed — through the browser's own editing command, so Ctrl+Z still undoes the formatting.
 */
export function diffRange(before: string, after: string): { from: number; to: number; insert: string } {
  let a = 0;
  const max = Math.min(before.length, after.length);
  while (a < max && before[a] === after[a]) a++;
  let b = 0;
  while (b < max - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
  return { from: a, to: before.length - b, insert: after.slice(a, after.length - b) };
}

const FENCE_OPEN = /^\s*(`{3,})[\w+#.-]*\s*$/;

/** Walks the lines before `upTo` the way the chat and the live view do: a block opened with n backticks is closed by a line of at least n bare backticks. */
function openFenceBefore(lines: readonly string[]): number {
  let open = 0;
  for (const l of lines) {
    if (open) {
      if (new RegExp(`^\\s*\`{${open},}\\s*$`).test(l)) open = 0;
    } else {
      const m = FENCE_OPEN.exec(l);
      if (m) open = m[1]!.length;
    }
  }
  return open;
}

/**
 * Where the caret is in terms of code blocks: `opening` = at the end of a line that opens a block (just typed ```), `inside` = in the middle of a block,
 * `outside` otherwise (a closing fence line counts as outside: Enter after it is an ordinary Enter). Same rule as `highlightLines` and the chat.
 */
export function fenceState(text: string, caret: number): 'outside' | 'opening' | 'inside' {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const nl = text.indexOf('\n', caret);
  const line = text.slice(lineStart, nl === -1 ? text.length : nl);
  const open = openFenceBefore(text.slice(0, lineStart).split('\n'));
  if (open) return new RegExp(`^\\s*\`{${open},}\\s*$`).test(line) ? 'outside' : 'inside';
  return FENCE_OPEN.test(line) ? 'opening' : 'outside';
}

/**
 * Enter at the end of an opening fence line: a new line for the code, and the closing fence below it when the block has none yet, so the block is complete as
 * soon as it is started. Inside a block Enter is a plain new line (the message is sent with ⌘/Ctrl+Enter instead).
 */
export function enterInFence(e: Edit): Edit | null {
  if (e.start !== e.end) return null;
  const st = fenceState(e.text, e.start);
  if (st === 'outside') return null;
  const { text, start } = e;
  if (st === 'inside') return { text: text.slice(0, start) + '\n' + text.slice(start), start: start + 1, end: start + 1 };
  // an opening line: is there a closing fence further down?
  const rest = text.slice(start).split('\n').slice(1);
  const fenceLen = FENCE_OPEN.exec(text.slice(text.lastIndexOf('\n', start - 1) + 1, text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start)))?.[1]?.length ?? 3;
  const closed = rest.some((l) => new RegExp(`^\\s*\`{${fenceLen},}\\s*$`).test(l));
  const ins = closed ? '\n' : '\n\n```';
  return { text: text.slice(0, start) + ins + text.slice(start), start: start + 1, end: start + 1 };
}

/**
 * A quote goes into the message at the caret (or at the end when the caret is at the very start of a box that already has text is not special-cased):
 * on its own paragraph, with a blank line after it, and the caret on that blank line, ready to type the reply.
 */
export function insertQuote(e: Edit, quote: string): Edit {
  // a selected text is never replaced by a quote: the quote goes after it
  const { text } = e;
  const start = e.end;
  const end = e.end;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = !after ? '\n\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const ins = `${lead}${quote}\n\n`;
  const caret = before.length + ins.length;
  return { text: before + ins + (tail === '\n\n' ? '' : tail) + after, start: caret, end: caret };
}
