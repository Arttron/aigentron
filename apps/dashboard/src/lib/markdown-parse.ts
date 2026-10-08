/**
 * Minimal, safe Markdown for chat output. Pure (no React, no HTML strings): it only produces a small
 * token tree that `Markdown.tsx` turns into React elements, so nothing the model writes can inject markup.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'link'; href: string; v: string };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'quote'; c: Inline[] };

/** Only http(s) and mailto links are ever rendered as links. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null;
  } catch {
    return null;
  }
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>)\]]+)|(\*[^*\s][^*\n]*\*)/g;

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
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const href = mm ? safeHref(mm[2]!) : null;
      out.push(href ? { t: 'link', href, v: mm![1]! } : { t: 'text', v: tok });
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
  return out;
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
