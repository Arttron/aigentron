import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/** Text formats a chat agent (no file tools) can be given inline. */
const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log', 'toml', 'ini', 'html', 'htm']);
export const isInlineTextName = (name: string): boolean => TEXT_EXT.has(extname(name).slice(1).toLowerCase());

export const PER_FILE_CHARS = 12_000;
export const TOTAL_CHARS = 24_000;
const MAX_READ_BYTES = 200 * 1024;

export interface InlineFile {
  name: string;
  text: string;
  truncated: boolean;
}

/** Reads the first part of each text file (bounded), within a total budget. Unreadable files are skipped. */
export async function readInlineFiles(paths: readonly string[], perFile = PER_FILE_CHARS, total = TOTAL_CHARS): Promise<InlineFile[]> {
  const out: InlineFile[] = [];
  let left = total;
  for (const p of paths) {
    if (left <= 0) break;
    if (!isInlineTextName(p)) continue;
    try {
      const st = await stat(p);
      if (!st.isFile()) continue;
      const fh = await open(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        let text = buf.subarray(0, bytesRead).toString('utf8').replace(/\r\n/g, '\n');
        if (text.includes('\u0000')) continue; // binary in disguise
        const limit = Math.min(perFile, left);
        const truncated = text.length > limit || st.size > bytesRead;
        text = text.slice(0, limit);
        left -= text.length;
        out.push({ name: basename(p), text, truncated });
      } finally {
        await fh.close();
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/** The prompt block carrying file contents as DATA (the person's own file — not instructions to the platform). */
export function inlineBlock(files: readonly InlineFile[]): string {
  if (!files.length) return '';
  return files
    .map((f) => `--- attached file: ${f.name}${f.truncated ? ' (cut: only the beginning is shown)' : ''} ---\n${f.text}\n--- end of ${f.name} ---`)
    .join('\n\n');
}
