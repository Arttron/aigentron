import { createReadStream, statSync } from 'node:fs';
import type { Request, Response } from 'express';

/**
 * Send a file honouring HTTP byte ranges — what a `<video>` element needs to seek (and what iOS Safari insists on before it plays at
 * all). Non-range requests stream the whole file.
 */
export function serveWithRanges(req: Request, res: Response, path: string): void {
  const size = statSync(path).size;
  res.setHeader('accept-ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (!m || (!m[1] && !m[2])) {
    res.setHeader('content-length', String(size));
    createReadStream(path).pipe(res);
    return;
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    res.status(416).setHeader('content-range', `bytes */${size}`).end();
    return;
  }
  res.status(206).setHeader('content-range', `bytes ${start}-${end}/${size}`);
  res.setHeader('content-length', String(end - start + 1));
  createReadStream(path, { start, end }).pipe(res);
}
