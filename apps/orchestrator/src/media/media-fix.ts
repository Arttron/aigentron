import { execFile } from 'node:child_process';
import { rename, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/**
 * A clip recorded in the browser (MediaRecorder → webm) has no length in its header, so most tools cannot tell how long it is.
 * Copying the streams into a fresh webm (`-c copy`, no re-encoding) writes the length and the seek index. (mp4 is not an option:
 * VP8, which Chrome often records, cannot live in mp4.) Best effort: any failure leaves the original file untouched.
 * Returns the new size when the file was rewritten, otherwise null.
 */
export async function remuxWebm(path: string, timeoutMs = 120_000): Promise<number | null> {
  const tmp = `${path}.${process.pid}.remux.webm`;
  try {
    await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0', '-c', 'copy', '-f', 'webm', '-y', tmp], { timeout: timeoutMs });
    const s = await stat(tmp);
    if (!s.isFile() || s.size === 0) throw new Error('empty result');
    await rename(tmp, path);
    return s.size;
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
    return null;
  }
}
