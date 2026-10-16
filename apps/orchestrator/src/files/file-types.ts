/**
 * The ONE table of file types the server knows: extension → MIME, kind, and how it may be served. Attachments, the resource
 * library, the workspace, the knowledge base and the media tools all derive their answers from here (they used to keep
 * eight slightly different lists). Pure — no IO.
 */

export type FileKind = 'image' | 'video' | 'pdf' | 'text' | 'file';

interface TypeInfo {
  mime: string;
  kind: FileKind;
  /** May be rendered by a browser as its real type (a browser can only display or download these, never run script from them). */
  inline?: boolean;
  /** Readable as plain text (the knowledge base extracts it as is; `text` kinds are also served inline as text/plain). */
  text?: boolean;
}

const T: Record<string, TypeInfo> = {
  // pictures
  png: { mime: 'image/png', kind: 'image', inline: true },
  jpg: { mime: 'image/jpeg', kind: 'image', inline: true },
  jpeg: { mime: 'image/jpeg', kind: 'image', inline: true },
  webp: { mime: 'image/webp', kind: 'image', inline: true },
  gif: { mime: 'image/gif', kind: 'image', inline: true },
  // video a browser can play (served with byte ranges)
  mp4: { mime: 'video/mp4', kind: 'video', inline: true },
  m4v: { mime: 'video/mp4', kind: 'video', inline: true },
  mov: { mime: 'video/quicktime', kind: 'video', inline: true },
  webm: { mime: 'video/webm', kind: 'video', inline: true },
  // video ffmpeg reads but browsers do not play: stored as video (same limits, video_digest works), downloaded when opened
  mkv: { mime: 'video/x-matroska', kind: 'video' },
  avi: { mime: 'video/x-msvideo', kind: 'video' },
  '3gp': { mime: 'video/3gpp', kind: 'video' },
  pdf: { mime: 'application/pdf', kind: 'pdf', inline: true },
  // plain text: shown in the dashboard / edited as a note, served inline as text/plain
  txt: { mime: 'text/plain', kind: 'text', text: true },
  text: { mime: 'text/plain', kind: 'text', text: true },
  md: { mime: 'text/markdown', kind: 'text', text: true },
  markdown: { mime: 'text/markdown', kind: 'text', text: true },
  csv: { mime: 'text/csv', kind: 'text', text: true },
  tsv: { mime: 'text/tab-separated-values', kind: 'text', text: true },
  json: { mime: 'application/json', kind: 'text', text: true },
  log: { mime: 'text/plain', kind: 'text', text: true },
  yaml: { mime: 'application/yaml', kind: 'text', text: true },
  yml: { mime: 'application/yaml', kind: 'text', text: true },
  xml: { mime: 'application/xml', kind: 'text', text: true },
  toml: { mime: 'application/toml', kind: 'text', text: true },
  ini: { mime: 'text/plain', kind: 'text', text: true },
  rst: { mime: 'text/x-rst', kind: 'text', text: true },
  // readable as text by the knowledge base, but never rendered (same-origin script) and not a "text note" either
  html: { mime: 'application/octet-stream', kind: 'file', text: true },
  htm: { mime: 'application/octet-stream', kind: 'file', text: true },
  // other known formats — a nicer Content-Type than a blanket octet-stream (they download either way)
  zip: { mime: 'application/zip', kind: 'file' },
  tar: { mime: 'application/x-tar', kind: 'file' },
  gz: { mime: 'application/gzip', kind: 'file' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'file' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'file' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'file' },
};

const UNKNOWN: TypeInfo = { mime: 'application/octet-stream', kind: 'file' };

/** Lower-case extension of a name or path, without the dot ('' when there is none). An extension alone ("PNG") works too. */
export function extOf(nameOrExt: string): string {
  const base = nameOrExt.slice(nameOrExt.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return (dot >= 0 ? base.slice(dot + 1) : base).toLowerCase();
}

const info = (nameOrExt: string): TypeInfo => T[extOf(nameOrExt)] ?? UNKNOWN;

/** Content-Type for a name / extension — known types get their real MIME, the rest a generic binary type. */
export const mimeFor = (nameOrExt: string): string => info(nameOrExt).mime;
export const kindFor = (nameOrExt: string): FileKind => info(nameOrExt).kind;
export const isImage = (nameOrExt: string): boolean => info(nameOrExt).kind === 'image';
export const isVideo = (nameOrExt: string): boolean => info(nameOrExt).kind === 'video';
export const isPdf = (nameOrExt: string): boolean => info(nameOrExt).kind === 'pdf';
/** A text note / plain-text file (shown and edited as text). */
export const isText = (nameOrExt: string): boolean => info(nameOrExt).kind === 'text';
/** Readable as text without a converter (plain text kinds plus HTML) — what the knowledge base can take as is. */
export const isTextLike = (nameOrExt: string): boolean => info(nameOrExt).text === true;
/** Safe to render inline in a browser as its real type: pictures, PDF, playable video. */
export const isInline = (nameOrExt: string): boolean => info(nameOrExt).inline === true;

export const IMAGE_EXTS = Object.keys(T).filter((e) => T[e]!.kind === 'image') as readonly string[];
export const VIDEO_EXTS = Object.keys(T).filter((e) => T[e]!.kind === 'video') as readonly string[];

/** MIME of a picture for the vision model (defaults to JPEG for anything odd, as before). */
export const imageMime = (name: string): string => (isImage(name) ? mimeFor(name) : 'image/jpeg');

/**
 * How a file is served to a browser — the single policy of every download route: pictures / PDF / playable video inline with their
 * real type, plain text inline as text/plain (cannot run as script), everything else (html, svg, js, office files, archives, mkv …)
 * forced to download. `mime` is what goes into Content-Type.
 */
export function servePolicy(name: string): { mime: string; inline: boolean; text: boolean } {
  const t = info(name);
  if (t.inline) return { mime: t.mime, inline: true, text: false };
  if (t.kind === 'text') return { mime: 'text/plain; charset=utf-8', inline: true, text: true };
  return { mime: t.mime, inline: false, text: false };
}
