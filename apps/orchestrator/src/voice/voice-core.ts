/**
 * Pure helpers for speech: the stored settings shape and validation, turning a Markdown answer into something worth reading
 * aloud, and audio file naming. No Nest, no I/O — unit-tested.
 */

export interface SttConfig {
  /** A provider from the registry (kind "openai": OpenAI itself, Groq, a local OpenAI-compatible server…). */
  provider: string;
  model: string;
  /** ISO-639-1 hint ("ru", "en"); empty = auto-detect. */
  language: string;
}
export interface TtsConfig {
  provider: string;
  model: string;
  voice: string;
  /** Longer answers are cut at a sentence boundary; the full text is always sent as text too. */
  maxChars: number;
}
export interface VoiceConfig {
  stt: SttConfig | null;
  tts: TtsConfig | null;
}

export const DEFAULT_MAX_CHARS = 1500;
export const MAX_CHARS_LIMIT = 4000;
/** Longest voice message we transcribe (and the biggest upload), so one message cannot cost a fortune. */
export const MAX_AUDIO_SECONDS = 300;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const EMPTY_VOICE: VoiceConfig = { stt: null, tts: null };

const str = (v: unknown, max = 120): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Normalises user input into a config, or says what is wrong. An empty stt/tts block switches that half off. */
export function parseVoiceConfig(input: unknown): { config: VoiceConfig; error?: undefined } | { config?: undefined; error: string } {
  const i = (input && typeof input === 'object' ? input : {}) as { stt?: Record<string, unknown> | null; tts?: Record<string, unknown> | null };
  let stt: SttConfig | null = null;
  let tts: TtsConfig | null = null;
  if (i.stt && (str(i.stt.provider) || str(i.stt.model))) {
    const s = { provider: str(i.stt.provider), model: str(i.stt.model), language: str(i.stt.language, 8).toLowerCase() };
    if (!s.provider) return { error: 'Speech-to-text: choose a provider.' };
    if (!s.model) return { error: 'Speech-to-text: give a model (e.g. gpt-4o-mini-transcribe or whisper-1).' };
    if (s.language && !/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(s.language)) return { error: 'Speech-to-text: the language is a short code like "ru" or "en" (or empty for automatic).' };
    stt = s;
  }
  if (i.tts && (str(i.tts.provider) || str(i.tts.model))) {
    const raw = Number(i.tts.maxChars);
    const maxChars = Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), MAX_CHARS_LIMIT) : DEFAULT_MAX_CHARS;
    const t = { provider: str(i.tts.provider), model: str(i.tts.model), voice: str(i.tts.voice, 60) || 'alloy', maxChars };
    if (!t.provider) return { error: 'Text-to-speech: choose a provider.' };
    if (!t.model) return { error: 'Text-to-speech: give a model (e.g. gpt-4o-mini-tts or tts-1).' };
    tts = t;
  }
  return { config: { stt, tts } };
}

/**
 * What to actually say. Markdown is for eyes: code blocks, links, tables and emoji sound terrible read aloud. Longer text is
 * cut at the last sentence end that fits (the full answer is in the text message anyway).
 */
export function speechText(markdown: string, maxChars = DEFAULT_MAX_CHARS): { text: string; truncated: boolean } {
  let t = markdown
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?[-:| ]{3,}\|?\s*$/gm, ' ')
    .replace(/\|/g, ', ')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\p{Extended_Pictographic}|\u200d|\ufe0f/gu, '')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.!?])\s*\.\s*/g, '$1 ')
    .trim();
  if (t.length <= maxChars) return { text: t, truncated: false };
  const cut = t.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('.\n'));
  t = end > maxChars * 0.5 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : maxChars)}…`;
  return { text: t.trim(), truncated: true };
}

const EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
};

/** A file name the transcription API accepts (it decides the format from the extension). */
export function audioFileName(mime: string | undefined, fallback = 'voice'): string {
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return `${fallback}.${EXT[base] ?? 'ogg'}`;
}

/** Whether a mime type is Ogg/Opus — what Telegram shows as a proper voice message. */
export const isOggOpus = (mime: string | undefined): boolean => /ogg|opus/i.test(mime ?? '');
