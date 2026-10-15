/** Photos and video for agents — pure helpers (unit-tested). */

export const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp'] as const;
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'] as const;

export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 20 * 60;
export const MAX_FRAMES = 24;
/** When the caller picks the interval, up to this many frames (a longer clip gets a larger step). */
export const MAX_FRAMES_EXPLICIT = 60;
export const MIN_EVERY_SECONDS = 1;
export const MAX_IMAGES_PER_LOOK = 8;

/** Phrases people say when they point at something on camera (Russian and English). */
export const POINTING_PHRASES = ['смотри', 'смотрите', 'посмотри', 'посмотрите', 'глянь', 'вот тут', 'вот здесь', 'вот это', 'вот', 'здесь', 'тут', 'look', 'see here', 'right here', 'over here', 'this one', 'here'];

export interface SpeechSegment {
  start: number;
  end: number;
  text: string;
  words?: { start: number; end: number; text: string }[];
}

/** What to take frames at: a fixed step, exact times, and/or the moments some words are said. */
export interface FramePlan {
  everySeconds?: number;
  atSeconds?: number[];
  phrases?: string[];
  /** The built-in list of "look here" phrases (POINTING_PHRASES). */
  pointing?: boolean;
}

export interface Moment {
  t: number;
  /** why this frame: the words said (or "at N s"). */
  why?: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The moments (seconds) when any of the phrases is said. With word timestamps the time is exact; otherwise it is estimated from the
 * position of the phrase inside its segment. A frame is taken `lag` s after the first word (the thing pointed at is on screen by then).
 */
export function momentsFromSpeech(segments: readonly SpeechSegment[], phrases: readonly string[], lag = 0.4): Moment[] {
  const list = phrases.map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  const out: Moment[] = [];
  for (const seg of segments) {
    const text = seg.text.toLowerCase();
    for (const hit of text.matchAll(re)) {
      const at = hit.index ?? 0;
      let t: number;
      if (seg.words?.length) {
        let pos = 0;
        let found = seg.words[0]!;
        for (const w of seg.words) {
          const idx = text.indexOf(w.text.toLowerCase(), pos);
          if (idx < 0) continue;
          if (idx > at) break;
          found = w;
          pos = idx + w.text.length;
        }
        t = found.start;
      } else {
        t = seg.start + (at / Math.max(1, text.length)) * Math.max(0, seg.end - seg.start);
      }
      const from = Math.max(0, at - 12);
      out.push({ t: Math.round((t + lag) * 100) / 100, why: `“${seg.text.slice(from, at + hit[0].length + 25).trim()}”` });
    }
  }
  return out;
}

/** Sorted, de-duplicated (frames closer than `gap` s are one), inside the video, at most `max`. */
export function mergeMoments(moments: readonly Moment[], durationSec: number, max = MAX_FRAMES_EXPLICIT, gap = 1.5): Moment[] {
  const sorted = moments.filter((m) => Number.isFinite(m.t) && m.t >= 0).map((m) => ({ ...m, t: Math.min(m.t, Math.max(0, durationSec - 0.1)) })).sort((a, b) => a.t - b.t);
  const out: Moment[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.t - last.t < gap) {
      if (!last.why && m.why) last.why = m.why;
      continue;
    }
    out.push({ ...m });
  }
  return out.length > max ? Array.from({ length: max }, (_, i) => out[Math.round((i * (out.length - 1)) / (max - 1))]!) : out;
}

const ext = (name: string): string => (name.split('.').pop() ?? '').toLowerCase();
export const isVideoName = (name: string): boolean => (VIDEO_EXTS as readonly string[]).includes(ext(name));
export const isImageName = (name: string): boolean => (IMAGE_EXTS as readonly string[]).includes(ext(name));

export const imageMime = (name: string): string => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' })[ext(name)] ?? 'image/jpeg';

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** `ffprobe -print_format json -show_format -show_streams` output → what we need. null = not a readable video. */
export function parseProbe(json: unknown): ProbeResult | null {
  const j = (json && typeof json === 'object' ? json : {}) as { format?: { duration?: string | number }; streams?: { codec_type?: string; width?: number; height?: number; duration?: string | number }[] };
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) return null;
  const dur = Number(j.format?.duration ?? video.duration ?? 0);
  if (!Number.isFinite(dur) || dur <= 0) return null;
  return { durationSec: dur, width: Number(video.width ?? 0), height: Number(video.height ?? 0), hasAudio: streams.some((s) => s.codec_type === 'audio') };
}

/**
 * Which moments of a video to look at: evenly spread, one frame about every 10 s, at least 4 (a short clip still gets a few), at most
 * `max`. Each is taken from the middle of its slice so the first frame is not a black fade-in.
 */
export function planFrames(durationSec: number, everySeconds?: number): number[] {
  if (!(durationSec > 0)) return [];
  // An explicit step: one frame per `everySeconds` (as many as fit, at most MAX_FRAMES_EXPLICIT — then the step grows).
  const step = everySeconds && everySeconds >= MIN_EVERY_SECONDS ? everySeconds : 0;
  const n = step
    ? Math.max(1, Math.min(MAX_FRAMES_EXPLICIT, Math.ceil(durationSec / step)))
    : Math.max(1, Math.min(MAX_FRAMES, Math.max(4, Math.ceil(durationSec / 10))));
  const count = durationSec < 2 ? 1 : n;
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * durationSec * 100) / count) / 100);
}

/** 83.4 → "1:23" ; 3725 → "1:02:05". */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export interface DigestInput {
  name: string;
  durationSec: number;
  width: number;
  height: number;
  frames: { t: number; path: string; why?: string }[];
  /** null = the video has no sound (or it could not be transcribed — see `transcriptNote`). */
  transcript: string | null;
  transcriptNote?: string;
  /** Timed phrases: when present the transcript is printed with timestamps. */
  segments?: SpeechSegment[];
  /** A note about how the frames were chosen (e.g. the phrases were not found). */
  frameNote?: string;
  /** Frames at chosen times / spoken moments rather than the automatic spread. */
  custom?: boolean;
  /** The step the caller asked for, if any. */
  everySeconds?: number;
}

/** The text an agent reads about a video: facts, where the frames are, and what was said. */
export function buildDigest(d: DigestInput): string {
  const lines = [
    `Video: ${d.name} — ${formatTime(d.durationSec)}${d.width ? `, ${d.width}×${d.height}` : ''}.`,
    '',
    `Frames (${d.frames.length}, ${d.everySeconds ? `about one per ${d.everySeconds} s${d.frames.length >= MAX_FRAMES_EXPLICIT ? ` (capped at ${MAX_FRAMES_EXPLICIT} frames)` : ''}` : d.custom ? 'at the requested moments' : 'evenly spread'} — Read a path to look at it, or use look_at with a question):`,
    ...d.frames.map((f) => `- ${formatTime(f.t)} → ${f.path}${f.why ? `  (said: ${f.why})` : ''}`),
    '',
  ];
  if (d.frameNote) lines.splice(lines.length - 1, 0, `Note: ${d.frameNote}`);
  if (d.segments?.length) lines.push('What was said (speech recognition, with the time each phrase starts):', ...d.segments.map((x) => `[${formatTime(x.start)}] ${x.text}`), '');
  else if (d.transcript) lines.push('What was said (speech recognition):', d.transcript.trim(), '');
  else lines.push(d.transcriptNote ? `Sound: ${d.transcriptNote}` : 'Sound: none recognised.', '');
  return lines.join('\n');
}

/** Files that hold secrets (sign-in tokens, env files): never readable through the agents' media tools, wherever they sit. */
export function isSecretPath(path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  if (parts.some((s) => s === 'auth.json' || s === '.codex-home' || /^\.env(\.|$)/.test(s))) return true;
  const i = parts.indexOf('codex-home');
  return i >= 0 && parts[i + 1] !== 'generated_images';
}

/** A path an agent gave us is only usable inside one of the allowed roots (no `..`, no other folders). */
export function insideRoot(path: string, roots: readonly string[]): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '');
  const p = norm(path);
  if (p.split('/').includes('..')) return false;
  return roots.some((r) => {
    const n = norm(r);
    return n !== '' && (p === n || p.startsWith(`${n}/`)); // an empty root must never allow everything
  });
}

// ------------------------------------------------------------- image sizes

/** What to do with an uploaded picture so it is as small as the agents (and people) need — a phone photo is 4000 px and 5 MB. */
export interface ImageFacts {
  ext: string;
  width: number;
  height: number;
  bytes: number;
  hasAlpha: boolean;
  /** more than one = an animation (left alone) */
  frames?: number;
}
export type ImagePlan = { action: 'skip' } | { action: 'recompress'; toExt: 'jpg' | 'png'; maxSide: number };

/** Pictures at or below these are left alone: already small. */
const SMALL_BYTES = 350 * 1024;

export function planImage(f: ImageFacts, maxSide: number): ImagePlan {
  const ext = f.ext.toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return { action: 'skip' }; // gif (may be animated), svg, heic, … untouched
  if (!(f.width > 0 && f.height > 0)) return { action: 'skip' };
  if ((f.frames ?? 1) > 1) return { action: 'skip' }; // an animated WebP would be flattened to its first frame
  const long = Math.max(f.width, f.height);
  if (long <= maxSide && f.bytes <= SMALL_BYTES) return { action: 'skip' };
  const photoLike = !f.hasAlpha; // transparency must survive: keep PNG for those
  if (long <= maxSide && f.bytes <= SMALL_BYTES * 2 && ext === 'png' && !photoLike) return { action: 'skip' };
  return { action: 'recompress', toExt: photoLike ? 'jpg' : 'png', maxSide };
}
