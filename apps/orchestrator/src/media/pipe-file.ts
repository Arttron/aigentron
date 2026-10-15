import type { Response } from 'express';
import { createReadStream } from 'node:fs';

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
