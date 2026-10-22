import { formatBytes } from './format-bytes';

/** One request body through the Cloudflare proxy (free plan: 100 MB) — a margin below it. A video may be this big. */
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

/** Everything else (a photo that was not shrunk, a PDF, a GIF …): the server's own limit per file. */
export const MAX_OTHER_BYTES = 10 * 1024 * 1024;

const isVideoFile = (f: { name: string; type?: string }): boolean => (f.type ?? '').startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(f.name);

/** The limit for this file: videos up to the proxy's, the rest up to what the server accepts. */
export const uploadLimitFor = (f: { name: string; type?: string }): number => (isVideoFile(f) ? MAX_UPLOAD_BYTES : MAX_OTHER_BYTES);

/** A clear refusal text when the file is too big to send, else null. Checked before anything is sent — and before a task is created without it. */
export function uploadSizeError(file: { name: string; size: number; type?: string }): string | null {
  const limit = uploadLimitFor(file);
  if (file.size <= limit) return null;
  const what = limit === MAX_UPLOAD_BYTES ? 'Trim or compress it (a shorter clip or lower quality) and try again.' : 'A photo is shrunk automatically; for a PDF or another file, send a smaller one or split it.';
  return `“${file.name}” is ${formatBytes(file.size)} — over the ${formatBytes(limit)} limit for this kind of file. ${what}`;
}
