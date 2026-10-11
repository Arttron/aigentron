import { extractText as pdfText, getDocumentProxy } from 'unpdf';
import * as mammoth from 'mammoth';
import { extractText } from './kb-core';

/** Hostile / huge documents: bounded pages, bounded time, bounded unpacked size. */
const MAX_PDF_PAGES = 600;
const PARSE_TIMEOUT_MS = 60_000;
const MAX_UNPACKED_BYTES = 120 * 1024 * 1024;

/** Sum of the uncompressed sizes a ZIP (.docx) declares in its central directory — read BEFORE anything is inflated. */
export function zipUnpackedSize(buf: Buffer): number {
  let total = 0;
  for (let i = buf.indexOf('PK\x01\x02', 0, 'latin1'); i >= 0 && i + 28 <= buf.length; i = buf.indexOf('PK\x01\x02', i + 4, 'latin1')) total += buf.readUInt32LE(i + 24);
  return total;
}

const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Reading the ${what} took too long (over ${PARSE_TIMEOUT_MS / 1000} s) — it may be damaged or very complex.`)), PARSE_TIMEOUT_MS).unref())]);

export const BINARY_DOC_EXTS = ['pdf', 'docx'] as const;
const ext = (name: string): string => (name.split('.').pop() ?? '').toLowerCase();
export const isReadableDoc = (name: string): boolean => (BINARY_DOC_EXTS as readonly string[]).includes(ext(name)) || extractText(name, Buffer.alloc(0)) !== null;

/** A document's bytes → text: plain text types directly, PDF (text layer, `[p. N]` markers) and Word (.docx, headings kept as Markdown). */
export async function extractDocument(name: string, data: Buffer): Promise<string> {
  const e = ext(name);
  if (e === 'pdf') {
    const pdf = await withTimeout(getDocumentProxy(new Uint8Array(data)), 'PDF');
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`This PDF has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}. Split it into parts.`);
    const { text } = await withTimeout(pdfText(pdf, { mergePages: false }), 'PDF');
    const pages = (Array.isArray(text) ? text : [String(text)]).map((t, i) => ({ n: i + 1, t: t.replace(/[ \t]+\n/g, '\n').trim() }));
    const body = pages.filter((p) => p.t).map((p) => `[p. ${p.n}]\n${p.t}`).join('\n\n');
    if (body.replace(/\[p\. \d+\]/g, '').trim().length < 20) throw new Error('This PDF has no text layer (it is a scan). Text recognition (OCR) is not available yet — use a text version.');
    return body;
  }
  if (e === 'docx') {
    if (zipUnpackedSize(data) > MAX_UNPACKED_BYTES) throw new Error('That Word file unpacks to an unreasonable size — refusing to read it.');
    const r = await withTimeout((mammoth as unknown as { convertToMarkdown(i: { buffer: Buffer }): Promise<{ value: string }> }).convertToMarkdown({ buffer: data }), 'Word file');
    const text = r.value.replace(/\\([.#*_()\-[\]!])/g, '$1').trim();
    if (!text) throw new Error('That Word file has no text.');
    return text;
  }
  const text = extractText(name, data);
  if (text === null) throw new Error(`Files of this type (.${e}) cannot be read — use PDF, Word (.docx), text, Markdown, HTML or CSV.`);
  return text;
}
