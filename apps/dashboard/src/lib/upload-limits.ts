import { formatBytes } from './format-bytes';

/** One request body through the Cloudflare proxy (free plan: 100 MB) — a margin below it. */
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

/** A clear refusal text when the file is too big to send, else null. Checked before anything is sent. */
export function uploadSizeError(file: { name: string; size: number }): string | null {
  if (file.size <= MAX_UPLOAD_BYTES) return null;
  return `“${file.name}” is ${formatBytes(file.size)} — over the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit. Trim or compress it (for video: a shorter clip or lower quality) and try again.`;
}
