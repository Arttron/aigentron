/**
 * Streaming file IO shared by every upload and download route: a size-limited stream → temp file → rename, and one way to send a
 * file to a browser (headers, byte ranges, error handling). There used to be four upload loops and three header policies.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { servePolicy } from './file-types';

export interface SaveOptions {
  /** Bytes allowed; one more and the stream is dropped, the temp file removed and `tooBig(limit)` thrown. */
  limit: number;
  tooBig: (limit: number) => Error;
  /** Called with the running size after every chunk — a place to throw for a quota that depends on other files. */
  check?: (size: number) => void;
}

/**
 * Write a stream to `tmp` (created exclusively — never over an existing file) and return the byte count. On any error (the connection
 * dropped, the limit hit, the disk full) the stream is closed first and the temp file removed, so nothing half-written stays behind.
 */
export async function saveStream(source: Readable, tmp: string, opts: SaveOptions): Promise<number> {
  const out = createWriteStream(tmp, { flags: 'wx' });
  // a failed open (EEXIST, EACCES, a full disk) arrives as an 'error' event: it must end the loop, not hang it
  const failed = new Promise<never>((_, reject) => out.once('error', reject));
  failed.catch(() => undefined);
  let size = 0;
  try {
    for await (const chunk of source) {
      size += (chunk as Buffer).length;
      if (size > opts.limit) throw opts.tooBig(opts.limit);
      opts.check?.(size);
      if (!out.write(chunk)) await Promise.race([once(out, 'drain'), failed]);
    }
    out.end();
    await Promise.race([once(out, 'finish'), failed]);
    return size;
  } catch (e) {
    // wait for the stream to close first: destroying it before it has opened would create the file right after the rm
    if (!out.closed) {
      await new Promise<void>((resolve) => {
        out.once('close', () => resolve());
        out.destroy();
      });
    }
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') await rm(tmp, { force: true }).catch(() => undefined); // EEXIST: that file was somebody else's
    throw e;
  }
}

/** A hidden `.xxxxxx.part` name next to `dest` — never listed, never served. */
export const partName = (dest: string): string => join(dirname(dest), `.${randomBytes(6).toString('hex')}.part`);

/** Stream → temp file next to `dest` → rename into place (replacing `dest`). Returns the byte count. */
export async function saveUpload(source: Readable, dest: string, opts: SaveOptions): Promise<number> {
  const tmp = partName(dest);
  const size = await saveStream(source, tmp, opts);
  await rename(tmp, dest).catch(async (e) => {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  });
  return size;
}

/** The whole request body in memory, refused with `tooBig(limit)` as soon as it exceeds the limit (for small documents only). */
export async function readBodyLimited(source: Readable, limit: number, tooBig: (limit: number) => Error): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of source) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    n += b.length;
    if (n > limit) throw tooBig(limit);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ serving

/**
 * Stream a file to the response. A read error (a directory, a vanished file, EIO) must end THIS response only:
 * an unhandled 'error' event on the stream would reach the process-level guard and take the whole server down.
 */
export function pipeFile(res: Response, path: string, range?: { start: number; end: number }): void {
  const stream = createReadStream(path, range);
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).type('text/plain').end('not found');
    else res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** `attachment; filename="ascii-fallback"; filename*=UTF-8''…` — non-ASCII names (кухня.docx) would make Node throw in a raw header. */
export function contentDisposition(type: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export interface ServeOptions {
  path: string;
  /** The name the browser sees (download name / type lookup) — a sanitized one, never the raw request parameter. */
  name?: string;
  /** Force a download even for an inline-safe type. */
  download?: boolean;
  cacheControl?: string;
}

/**
 * Send a file the one safe way: only a regular file (404 otherwise), `X-Content-Type-Options: nosniff`, the type and inline/download
 * decision from the file-types policy (pictures / PDF / playable video inline, text as text/plain, everything else a download with an
 * RFC 5987 file name), and HTTP byte ranges for every file (what a `<video>` needs to seek — iOS refuses to play without them).
 */
export async function serveFile(req: Request, res: Response, o: ServeOptions): Promise<void> {
  const st = await stat(o.path).catch(() => null);
  if (!st?.isFile()) {
    res.status(404).type('text/plain').end('not found');
    return;
  }
  const name = o.name ?? basename(o.path);
  const policy = servePolicy(name);
  res.setHeader('content-type', policy.mime);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', o.cacheControl ?? 'private, max-age=300');
  if (!policy.inline || o.download) res.setHeader('content-disposition', contentDisposition('attachment', name));
  res.setHeader('accept-ranges', 'bytes');
  const size = st.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (!m || (!m[1] && !m[2])) {
    res.setHeader('content-length', String(size));
    pipeFile(res, o.path);
    return;
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    res.status(416).setHeader('content-range', `bytes */${size}`);
    res.end();
    return;
  }
  res.status(206).setHeader('content-range', `bytes ${start}-${end}/${size}`);
  res.setHeader('content-length', String(end - start + 1));
  pipeFile(res, o.path, { start, end });
}
