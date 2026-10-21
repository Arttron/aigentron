/**
 * Minimal, safe Markdown for chat output. Pure (no React, no HTML strings): it only produces a small
 * token tree that `Markdown.tsx` turns into React elements, so nothing the model writes can inject markup.
 */

import { contrastText, cssColor, findColors, parseColor } from './color-chip';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'link'; href: string; v: string }
  /** A file of the task shown inline, loaded by its name from the task's attachments (nothing is copied into the message). */
  | { t: 'media'; name: string; alt: string }
  /** A colour value written in the text, shown on a chip of that colour with a readable text colour (both rebuilt from the parsed numbers). */
  | { t: 'color'; v: string; bg: string; fg: string };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'table'; head: Inline[][]; align: Align[]; rows: Inline[][][] };

export type Align = 'left' | 'right' | 'center' | null;

/** Only http(s) and mailto links are ever rendered as links. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null;
  } catch {
    return null;
  }
}

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v)$/i;

/**
 * The name of a task attachment a link points at, or null. Accepted: `name.png`, `attachment:name.png`, `attachments/name.png`, or a path
 * ending in the file (an agent knows the folder, the page does not). Never a URL of another site: pictures from outside are not loaded.
 */
export function mediaName(ref: string): string | null {
  let r = ref.trim().replace(/^<|>$/g, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(r) && !/^attachments?:/i.test(r)) return null;
  r = r.replace(/^attachments?:\/*/i, '');
  try {
    r = decodeURIComponent(r);
  } catch {
    /* keep as typed */
  }
  const name = r.split(/[\\/]/).pop() ?? '';
  return name && name !== '..' && MEDIA_EXT.test(name) ? name : null;
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(!?\[[^\]\n]*\]\([^)\s]+\))|(https?:\/\/[^\s<>)\]]+)|(\*[^*\s][^*\n]*\*)/g;

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: 'text', v: src.slice(last, i) });
    const [tok] = m;
    if (m[1]) out.push({ t: 'code', v: tok.slice(1, -1) });
    else if (m[2]) out.push(depth < 2 ? { t: 'bold', c: parseInline(tok.slice(2, -2), depth + 1) } : { t: 'text', v: tok });
    else if (m[3]) {
      const mm = /^!?\[([^\]]*)\]\(([^)]+)\)$/.exec(tok);
      const media = mm ? mediaName(mm[2]!) : null;
      const href = mm && !media ? safeHref(mm[2]!) : null;
      if (mm && media) out.push({ t: 'media', name: media, alt: mm[1]! });
      else out.push(href && mm![1] ? { t: 'link', href, v: mm![1]! } : { t: 'text', v: tok });
    } else if (m[4]) {
      // Trailing punctuation belongs to the sentence, not the URL.
      const trimmed = tok.replace(/[.,;:!?]+$/, '');
      const href = safeHref(trimmed);
      out.push(href ? { t: 'link', href, v: trimmed } : { t: 'text', v: trimmed });
      if (trimmed.length < tok.length) out.push({ t: 'text', v: tok.slice(trimmed.length) });
    } else if (m[5]) out.push(depth < 2 ? { t: 'italic', c: parseInline(tok.slice(1, -1), depth + 1) } : { t: 'text', v: tok });
    last = i + tok.length;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return expandColors(out);
}

function chip(text: string, c: NonNullable<ReturnType<typeof parseColor>>): Inline {
  return { t: 'color', v: text, bg: cssColor(c), fg: contrastText(c) };
}

/** Colour values inside plain text become chips; an inline code that is nothing but a colour does too (any short hex there: the author meant a colour). */
function expandColors(tokens: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const t of tokens) {
    if (t.t === 'code') {
      const c = parseColor(t.v);
      out.push(c ? chip(t.v, c) : t);
    } else if (t.t === 'text') {
      let at = 0;
      for (const f of findColors(t.v)) {
        if (f.start > at) out.push({ t: 'text', v: t.v.slice(at, f.start) });
        out.push(chip(f.text, f.color));
        at = f.end;
      }
      if (at === 0) out.push(t);
      else if (at < t.v.length) out.push({ t: 'text', v: t.v.slice(at) });
    } else out.push(t);
  }
  return out;
}

/** Cells of one table row: `| a | b |` → ['a', 'b'] (a `\|` is a literal pipe). */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** The `|---|:--:|--:|` line under a table header: the alignment of each column, or null when the line is not one. */
export function parseSeparator(line: string): Align[] | null {
  if (!line.includes('-') || !line.includes('|') && !/^\s*:?-{3,}:?\s*$/.test(line)) return null;
  const cells = splitRow(line);
  if (!cells.length || !cells.every((c) => /^:?-{1,}:?$/.test(c))) return null;
  return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
}

/** A column whose every body cell is a number (with $ € % , spaces and a sign) reads better right-aligned. */
export function isNumericColumn(cells: readonly string[]): boolean {
  const body = cells.filter((c) => c.trim() !== '' && c.trim() !== '—' && c.trim() !== '-');
  return body.length > 0 && body.every((c) => /^[~≈<>+-]?\s*[$€£]?\s*\d[\d\s.,']*\s*[%$€£]?$/.test(c.replace(/\*\*/g, '').trim()));
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ t: 'code', lang: fence[1] ?? '', v: body.join('\n') }); // an unclosed fence runs to the end (streaming)
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: 'h', level: h[1]!.length, c: parseInline(h[2]!) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(parseInline(lines[i++]!.replace(/^\s*[-*]\s+/, '')));
      i--;
      blocks.push({ t: 'ul', items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(parseInline(lines[i++]!.replace(/^\s*\d+[.)]\s+/, '')));
      i--;
      blocks.push({ t: 'ol', items });
      continue;
    }
    // A table: a header row with pipes, then a |---| separator line, then rows until a line without pipes.
    if (line.includes('|') && i + 1 < lines.length) {
      const sep = parseSeparator(lines[i + 1]!);
      const head = splitRow(line);
      if (sep && head.length >= 2 && sep.length === head.length) {
        flush();
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(splitRow(lines[i++]!));
        i--;
        const align: Align[] = sep.map((a, c) => a ?? (isNumericColumn(rows.map((r) => r[c] ?? '')) ? 'right' : null));
        blocks.push({
          t: 'table',
          head: head.map((c) => parseInline(c)),
          align,
          rows: rows.map((r) => head.map((_, c) => parseInline(r[c] ?? ''))),
        });
        continue;
      }
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      i--;
      blocks.push({ t: 'quote', c: parseInline(q.join('\n')) });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return blocks;
}
