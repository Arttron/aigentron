/** How a task file can be previewed in the dashboard. Mirrors the server's file-types policy (text served as text/plain; html only ever shown sandboxed). */
export type DocKind = 'md' | 'html' | 'csv' | 'json' | 'text' | 'pdf';

const TEXT = new Set(['txt', 'text', 'log', 'yaml', 'yml', 'xml', 'toml', 'ini', 'rst']);

export function docKind(name: string): DocKind | null {
  const ext = (name.split(/[\\/]/).pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'json') return 'json';
  if (ext === 'pdf') return 'pdf';
  return TEXT.has(ext) ? 'text' : null;
}

/** A small CSV/TSV reader (quotes, doubled quotes, embedded newlines). */
export function parseDelimited(src: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
