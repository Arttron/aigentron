/** Knowledge base — pure helpers (unit-tested): tokenizer, chunking, BM25, vectors, rank fusion. */

// ---------------------------------------------------------------- tokens

/** Endings stripped from English words (longest first); Russian words are cut to a fixed-length stem. */
const EN_SUFFIXES = ['ations', 'ation', 'ingly', 'ings', 'ing', 'edly', 'ed', 'ies', 'es', 'ly', 's'];
const RU_STEM = 5;
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'and', 'or', 'is', 'are', 'for', 'with', 'и', 'в', 'на', 'с', 'по', 'к', 'о', 'у', 'за', 'из', 'от', 'что', 'это', 'как']);

/** Light, language-agnostic normalisation: lowercase, split on non-letters, cheap stemming. "Running"/"runs" and "стенами"/"стене" meet. */
const CJK = /([\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+)/u;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)) {
    if (!piece) continue;
    // Chinese / Japanese / Korean have no spaces: index overlapping character pairs (a lone character stands for itself)
    for (const raw of CJK.test(piece) ? piece.split(CJK).filter(Boolean) : [piece]) {
      if (CJK.test(raw)) {
        const chars = [...raw];
        if (chars.length === 1) out.push(raw);
        for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
        continue;
      }
      if (raw.length < 2 || STOP.has(raw)) continue;
      out.push(stem(raw));
    }
  }
  return out;
}

export function stem(w: string): string {
  if (/^\d+$/.test(w)) return w;
  if (/[а-яё]/.test(w)) return w.length > RU_STEM ? w.slice(0, RU_STEM) : w;
  if (!/^[a-z]+$/.test(w)) return w.length > 7 ? w.slice(0, 7) : w;
  let r = w;
  for (const s of EN_SUFFIXES) {
    if (w.length > s.length + 2 && w.endsWith(s)) {
      r = w.slice(0, -s.length);
      break;
    }
  }
  // cure / curing, tile / tiles meet
  return r.length > 3 && r.endsWith('e') ? r.slice(0, -1) : r;
}

// -------------------------------------------------------------- chunking

export type ChunkStrategy = 'section' | 'paragraph' | 'chars';

export interface ChunkingConfig {
  strategy: ChunkStrategy;
  /** Hard cap per chunk (characters). */
  maxChars: number;
  /** Characters repeated between neighbouring chunks when a long text is cut (chars strategy / oversize fallbacks). */
  overlap: number;
  /** Fragments shorter than this are merged into a neighbour. */
  minChars: number;
}

export const DEFAULT_CHUNKING: ChunkingConfig = { strategy: 'section', maxChars: 3000, overlap: 200, minChars: 200 };

export interface Chunk {
  /** "Chapter > Section" the chunk sits under (markdown headings), '' when none. */
  heading: string;
  text: string;
}

/** Clamp a user-supplied config into sane bounds. */
export function cleanChunking(input: Partial<ChunkingConfig> | null | undefined): ChunkingConfig {
  const d = DEFAULT_CHUNKING;
  const strategy: ChunkStrategy = input?.strategy === 'paragraph' || input?.strategy === 'chars' || input?.strategy === 'section' ? input.strategy : d.strategy;
  const num = (v: unknown, def: number, lo: number, hi: number): number => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : def);
  const maxChars = num(input?.maxChars, d.maxChars, 300, 12000);
  return { strategy, maxChars, overlap: Math.min(num(input?.overlap, d.overlap, 0, 2000), Math.floor(maxChars / 2)), minChars: Math.min(num(input?.minChars, d.minChars, 0, 2000), Math.floor(maxChars / 2)) };
}

/**
 * A line that starts a new clause: a Markdown heading, a numbered clause that begins with a capital (`1.2 Plaster …`, `3) The …` — not a year
 * like "2024. The company" nor a lower-case list item), or a keyword heading with its number and a separator (`Article 4.`, `Статья 4:`).
 */
const MARKER = new RegExp(
  '^(?:#{1,6}\\s|(?:\\d{1,3}\\.){1,4}\\d{0,3}\\s+[\\p{Lu}("«\\[\\d]|\\d{1,3}[.)]\\s+[\\p{Lu}("«\\[]|(?:Article|Section|Chapter|Part|Статья|Глава|Раздел|Часть|п\\.|Пункт)\\s*\\d+(?:\\.\\d+)*\\s*[.:—–-])',
  'u',
);

/** Cut a long text into windows of ≤ max characters, snapping to a sentence / word boundary, repeating `overlap` characters. */
export function cutChars(text: string, max: number, overlap: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
      const window = text.slice(start, end);
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'), window.lastIndexOf('? '), window.lastIndexOf('! '), window.lastIndexOf('\n\n'));
      const space = window.lastIndexOf(' ');
      const cut = sentence > max * 0.5 ? sentence + 1 : space > max * 0.5 ? space : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

/** Paragraphs (blank-line separated) merged up to `max` characters; one oversize paragraph is cut by characters. */
function packParagraphs(text: string, cfg: ChunkingConfig): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length > cfg.maxChars) {
      if (cur) out.push(cur);
      cur = '';
      out.push(...cutChars(para, cfg.maxChars, cfg.overlap));
    } else if (cur && cur.length + para.length + 2 > cfg.maxChars) {
      out.push(cur);
      cur = para;
    } else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) out.push(cur);
  return out;
}

/** Split a document into chunks by the chosen strategy. Pure; the same input always gives the same chunks. */
export function chunkText(text: string, cfgIn?: Partial<ChunkingConfig>): Chunk[] {
  const cfg = cleanChunking(cfgIn);
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!clean) return [];
  if (cfg.strategy === 'chars') return cutChars(clean, cfg.maxChars, cfg.overlap).map((t) => ({ heading: '', text: t }));
  if (cfg.strategy === 'paragraph') return packParagraphs(clean, cfg).map((t) => ({ heading: '', text: t }));

  // section: each heading / numbered clause starts a new piece; a clause stays whole
  const sections: { heading: string; lines: string[] }[] = [];
  const path: string[] = [];
  let cur: { heading: string; lines: string[] } = { heading: '', lines: [] };
  const flush = (): void => {
    const body = cur.lines.filter((l) => l.trim() && !/^#{1,6}\s/.test(l));
    if (body.length) sections.push(cur); // a heading with nothing under it only contributes to the path of what follows
  };
  for (const line of clean.split('\n')) {
    const md = /^(#{1,6})\s+(.*\S)/.exec(line);
    if (md) {
      flush();
      path.length = md[1]!.length - 1;
      path[md[1]!.length - 1] = md[2]!.trim();
      cur = { heading: path.filter(Boolean).join(' > '), lines: [line] };
    } else if (MARKER.test(line.trim()) && cur.lines.join('').length > 0) {
      flush();
      cur = { heading: cur.heading, lines: [line] };
    } else cur.lines.push(line);
  }
  flush();

  // merge tiny sections into their neighbour, split oversize ones
  const merged: { heading: string; text: string }[] = [];
  for (const s of sections) {
    const text = s.lines.join('\n').trim();
    const last = merged[merged.length - 1];
    if (last && last.heading === s.heading && (last.text.length < cfg.minChars || text.length < cfg.minChars) && last.text.length + text.length + 2 <= cfg.maxChars) last.text = `${last.text}\n\n${text}`;
    else merged.push({ heading: s.heading, text });
  }
  const out: Chunk[] = [];
  for (const m of merged) {
    if (m.text.length <= cfg.maxChars) out.push({ heading: m.heading, text: m.text });
    else for (const piece of packParagraphs(m.text, cfg)) out.push({ heading: m.heading, text: piece });
  }
  return out;
}

// ------------------------------------------------------------------ BM25

export interface Scored {
  /** index of the chunk in the order it was added */
  idx: number;
  score: number;
}

/** In-memory BM25 over chunk texts (headings count double). Built from the stored chunks; cheap to rebuild. */
export class Bm25Index {
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly lengths: number[] = [];
  private total = 0;

  constructor(private readonly k1 = 1.2, private readonly b = 0.75) {}

  get size(): number {
    return this.lengths.length;
  }

  add(heading: string, text: string): number {
    const idx = this.lengths.length;
    const tokens = [...tokenize(heading), ...tokenize(heading), ...tokenize(text)];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Map()));
      p.set(idx, n);
    }
    this.lengths.push(tokens.length);
    this.total += tokens.length;
    return idx;
  }

  search(query: string, limit: number, allow?: (idx: number) => boolean): Scored[] {
    const q = [...new Set(tokenize(query))];
    const n = this.lengths.length;
    if (!q.length || !n) return [];
    const avg = this.total / n || 1;
    const scores = new Map<number, number>();
    for (const term of q) {
      const p = this.postings.get(term);
      if (!p) continue;
      const idf = Math.log(1 + (n - p.size + 0.5) / (p.size + 0.5));
      for (const [idx, tf] of p) {
        if (allow && !allow(idx)) continue;
        const len = this.lengths[idx]!;
        scores.set(idx, (scores.get(idx) ?? 0) + (idf * (tf * (this.k1 + 1))) / (tf + this.k1 * (1 - this.b + (this.b * len) / avg)));
      }
    }
    return [...scores].map(([idx, score]) => ({ idx, score })).sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// --------------------------------------------------------------- vectors

/** Unit-length Float32 → base64 (compact column), and back. */
export function encodeVector(v: ArrayLike<number>): string {
  const f = Float32Array.from(v as ArrayLike<number>);
  let norm = 0;
  for (const x of f) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < f.length; i++) f[i] = f[i]! / norm;
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

export function decodeVector(s: string): Float32Array {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** Dot product (= cosine for unit vectors). */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** Top-k by similarity over a list of vectors (null = chunk has none). */
export function topBySimilarity(query: Float32Array, vectors: readonly (Float32Array | null)[], limit: number, allow?: (idx: number) => boolean): Scored[] {
  const out: Scored[] = [];
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!v || (allow && !allow(i))) continue;
    out.push({ idx: i, score: dot(query, v) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Reciprocal-rank fusion of several ranked lists (robust when scores are not comparable: BM25 vs cosine). */
export function fuseRanks(lists: readonly Scored[][], limit: number, k = 60): Scored[] {
  const score = new Map<number, number>();
  for (const list of lists) list.forEach((s, rank) => score.set(s.idx, (score.get(s.idx) ?? 0) + 1 / (k + rank + 1)));
  return [...score].map(([idx, s]) => ({ idx, score: s })).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ------------------------------------------------------- text extraction

/** HTML → readable text (scripts/styles dropped, block tags → newlines, entities decoded). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|ul|ol|table|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export const TEXT_EXTS = ['md', 'markdown', 'txt', 'text', 'csv', 'log', 'json', 'html', 'htm', 'rst', 'tsv', 'yaml', 'yml'] as const;
export const isTextName = (name: string): boolean => (TEXT_EXTS as readonly string[]).includes((name.split('.').pop() ?? '').toLowerCase());

/** A file's bytes → text for the base, by extension. null = a type we cannot read (yet). */
export function extractText(name: string, data: Buffer): string | null {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (!isTextName(name)) return null;
  const text = data.toString('utf8').replace(/^\uFEFF/, '');
  return ext === 'html' || ext === 'htm' ? htmlToText(text) : text;
}
