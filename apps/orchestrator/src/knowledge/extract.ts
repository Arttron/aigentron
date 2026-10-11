import { extractText as pdfText, getDocumentProxy } from 'unpdf';
import * as mammoth from 'mammoth';
import { extractText } from './kb-core';

export const BINARY_DOC_EXTS = ['pdf', 'docx'] as const;
const ext = (name: string): string => (name.split('.').pop() ?? '').toLowerCase();
export const isReadableDoc = (name: string): boolean => (BINARY_DOC_EXTS as readonly string[]).includes(ext(name)) || extractText(name, Buffer.alloc(0)) !== null;

/** A document's bytes → text: plain text types directly, PDF (text layer, `[p. N]` markers) and Word (.docx, headings kept as Markdown). */
export async function extractDocument(name: string, data: Buffer): Promise<string> {
  const e = ext(name);
  if (e === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await pdfText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [String(text)]).map((t, i) => ({ n: i + 1, t: t.replace(/[ \t]+\n/g, '\n').trim() }));
    const body = pages.filter((p) => p.t).map((p) => `[p. ${p.n}]\n${p.t}`).join('\n\n');
    if (body.replace(/\[p\. \d+\]/g, '').trim().length < 20) throw new Error('This PDF has no text layer (it is a scan). Text recognition (OCR) is not available yet — use a text version.');
    return body;
  }
  if (e === 'docx') {
    const r = await (mammoth as unknown as { convertToMarkdown(i: { buffer: Buffer }): Promise<{ value: string }> }).convertToMarkdown({ buffer: data });
    const text = r.value.replace(/\\([.#*_()\-[\]!])/g, '$1').trim();
    if (!text) throw new Error('That Word file has no text.');
    return text;
  }
  const text = extractText(name, data);
  if (text === null) throw new Error(`Files of this type (.${e}) cannot be read — use PDF, Word (.docx), text, Markdown, HTML or CSV.`);
  return text;
}
