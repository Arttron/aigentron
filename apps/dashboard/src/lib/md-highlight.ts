import { hugs, safeHref } from './markdown-parse';

/**
 * Live formatting of what is being typed: the text split into styled pieces WITHOUT changing a single character, so a copy drawn from these pieces lines up
 * exactly over the real `<textarea>` (which keeps the caret, selection, paste and input methods). The pieces say what to dim (the Markdown marks) and what to
 * emphasise; the drawing only uses styles that do not change the width of a letter.
 */
export type HlClass = 'mark' | 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'url' | 'bullet' | 'quote' | 'lang';

export interface Seg {
  text: string;
  cls: HlClass[];
}

/** One line of the message (without its newline) and what kind of line it is. */
export interface HlLine {
  kind: 'plain' | 'fence' | 'code';
  segs: Seg[];
}

const FENCE_OPEN = /^(\s*)(`{3,})\s*([\w+#.-]*)\s*$/;
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\[\]\n]*\]\([^)\s]+\))|(https?:\/\/[^\s<>)\]]+)|(\*[^*\s][^*\n]*\*)|(~~[^~\n]+~~)/g;

function inline(src: string, parent: HlClass[], depth: number, before: string, out: Seg[]): void {
  let last = 0;
  const push = (text: string, cls: HlClass[]) => text && out.push({ text, cls: [...parent, ...cls] });
  for (const m of src.matchAll(INLINE)) {
    const at = m.index ?? 0;
    const tok = m[0];
    const marks = m[2] ? 2 : m[5] ? 1 : m[6] ? 2 : 0;
    // a mark only counts when it hugs what it marks (same rule as the formatted view), so the field and the chat agree
    if (marks && !hugs(before + src, before.length + at, tok, marks)) continue;
    push(src.slice(last, at), []);
    if (m[1]) {
      push('`', ['mark']);
      push(tok.slice(1, -1), ['code']);
      push('`', ['mark']);
    } else if (m[2] || m[5] || m[6]) {
      const cls: HlClass = m[2] ? 'bold' : m[5] ? 'italic' : 'strike';
      const mark = tok.slice(0, marks);
      push(mark, ['mark']);
      if (depth < 2) inline(tok.slice(marks, tok.length - marks), [...parent, cls], depth + 1, '', out);
      else push(tok.slice(marks, tok.length - marks), [cls]);
      push(mark, ['mark']);
    } else if (m[3]) {
      const close = tok.indexOf('](');
      // an address the chat would not link (javascript:, data:) is shown as plain text here too
      if (!safeHref(tok.slice(close + 2, -1))) {
        push(tok, []);
        last = at + tok.length;
        continue;
      }
      push('[', ['mark']);
      push(tok.slice(1, close), ['link']);
      push('](', ['mark']);
      push(tok.slice(close + 2, -1), ['url']);
      push(')', ['mark']);
    } else {
      const trimmed = tok.replace(/[.,;:!?]+$/, '');
      push(trimmed, ['url']);
      push(tok.slice(trimmed.length), []);
    }
    last = at + tok.length;
  }
  push(src.slice(last), []);
}

/** The lines of the text, styled. Concatenating a line's pieces gives back that line exactly. */
export function highlightLines(src: string): HlLine[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: HlLine[] = [];
  let fence = 0; // the length of the open fence, 0 = outside a block
  for (const line of lines) {
    if (fence) {
      if (new RegExp(`^\\s*\`{${fence},}\\s*$`).test(line)) {
        out.push({ kind: 'fence', segs: [{ text: line, cls: ['mark'] }] });
        fence = 0;
      } else out.push({ kind: 'code', segs: [{ text: line, cls: ['code'] }] });
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[2]!.length;
      const lead = open[1]! + open[2]!;
      const lang = open[3]!;
      const rest = line.slice(lead.length + 0);
      const segs: Seg[] = [{ text: lead, cls: ['mark'] }];
      if (lang) {
        const at = rest.indexOf(lang);
        if (at > 0) segs.push({ text: rest.slice(0, at), cls: ['mark'] });
        segs.push({ text: lang, cls: ['lang'] });
        if (rest.length > at + lang.length) segs.push({ text: rest.slice(at + lang.length), cls: ['mark'] });
      } else if (rest) segs.push({ text: rest, cls: ['mark'] });
      out.push({ kind: 'fence', segs });
      continue;
    }
    const segs: Seg[] = [];
    let body = line;
    let consumed = 0;
    const ul = /^(\s*)([-*])(\s+)/.exec(line);
    const ol = /^(\s*)(\d+[.)])(\s+)/.exec(line);
    const q = /^(\s*)(>)(\s?)/.exec(line);
    const m = ul ?? ol ?? q;
    if (m) {
      const [whole, lead, mark] = m;
      if (lead) segs.push({ text: lead, cls: [] });
      segs.push({ text: mark!, cls: [q ? 'quote' : 'bullet'] });
      const gap = whole!.slice(lead!.length + mark!.length);
      if (gap) segs.push({ text: gap, cls: [] });
      consumed = whole!.length;
      body = line.slice(consumed);
    }
    inline(body, [], 0, line.slice(0, consumed), segs);
    out.push({ kind: 'plain', segs });
  }
  return out;
}
