import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * VoiceLab (voicelab.uz) speech API — not OpenAI-compatible, so it has its own small client. A provider of kind "openai" whose Base URL is on
 * voicelab.uz (https://api.voicelab.uz/v1) selects it; the key is the provider's key (sent as a Bearer token).
 *
 *   TTS  POST /v1/tts {text, language, voice_id, speed}  → 200 audio/wav (mono 16-bit, 24 kHz), or 202 {id, status, status_url} to poll
 *   STT  POST /v1/stt (multipart: audio, language) + Idempotency-Key → 202 {id, status}; GET /v1/stt/transcriptions/{id} → {status: queued|processing|completed|failed, transcript, segments[{start_ms,end_ms,text}]}
 *   Voices  GET /v1/voices
 *
 * Written from the public documentation; the response keys are read leniently (several spellings) because the docs do not pin every field down.
 */

export const isVoicelabBase = (base: string): boolean => {
  try {
    const h = new URL(base).hostname.toLowerCase();
    return h === 'voicelab.uz' || h.endsWith('.voicelab.uz');
  } catch {
    return false;
  }
};

/** `https://api.voicelab.uz/v1` or `https://api.voicelab.uz` → `https://api.voicelab.uz/v1`. */
export const apiRoot = (base: string): string => `${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;

type Fetch = typeof fetch;
export interface VlCtx {
  base: string;
  headers: Record<string, string>;
  fetch?: Fetch;
  /** Poll pause / limit — tests make them tiny. */
  pollMs?: number;
  maxWaitMs?: number;
  signalMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = (o: unknown, keys: string[]): unknown => {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) if ((o as Record<string, unknown>)[k] !== undefined) return (o as Record<string, unknown>)[k];
  return undefined;
};

/** A short message out of an error body (`{error:{message}}`, `{message}`, `{detail}`, or plain text). */
export function vlError(status: number, text: string): string {
  let m = '';
  try {
    const j = JSON.parse(text) as unknown;
    const e = pick(j, ['error']);
    m = String(pick(e, ['message']) ?? (typeof e === 'string' ? e : '') ?? pick(j, ['message', 'detail']) ?? '');
    if (!m || m === 'undefined') m = String(pick(j, ['message', 'detail']) ?? '');
  } catch {
    /* not JSON */
  }
  const hint = status === 401 ? ' (check the API key and its permissions)' : status === 402 ? ' (not enough VoiceLab credits)' : status === 429 ? ' (rate limit — try again shortly)' : '';
  return `${m || `HTTP ${status}${text ? `: ${text.slice(0, 160)}` : ''}`}${hint}`.slice(0, 260);
}

/** Text → WAV audio. */
export async function vlSynthesize(ctx: VlCtx, p: { text: string; language: string; voiceId: string; speed?: number }): Promise<Buffer> {
  const f = ctx.fetch ?? fetch;
  const root = apiRoot(ctx.base);
  const res = await f(`${root}/tts`, {
    method: 'POST',
    headers: { ...ctx.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ text: p.text, language: p.language, voice_id: p.voiceId, ...(p.speed ? { speed: p.speed } : {}) }),
    signal: AbortSignal.timeout(ctx.signalMs ?? 60_000),
  });
  if (!res.ok) throw new Error(vlError(res.status, await res.text()));
  if (!/json/i.test(res.headers.get('content-type') ?? '')) return Buffer.from(await res.arrayBuffer());
  // a longer text comes back as a job: follow its status address until it names the audio
  let job: unknown = await res.json();
  const until = Date.now() + (ctx.maxWaitMs ?? 90_000);
  for (;;) {
    const audio = pick(job, ['audioUrl', 'audio_url', 'downloadUrl', 'download_url', 'url']);
    if (typeof audio === 'string' && /^https?:|^\//.test(audio) && !/status/i.test(String(pick(job, ['status']) ?? '')) ) return download(ctx, audio);
    const status = String(pick(job, ['status', 'state']) ?? '').toLowerCase();
    if (/fail|error|cancel/.test(status)) throw new Error(`Synthesis failed: ${String(pick(job, ['error', 'message']) ?? status)}`.slice(0, 240));
    if (typeof audio === 'string' && /done|complete|succe|ready/.test(status)) return download(ctx, audio);
    const next = pick(job, ['statusUrl', 'status_url', 'jobUrl', 'job_url']);
    if (typeof next !== 'string' || Date.now() > until) throw new Error('VoiceLab did not return the audio in time.');
    await sleep(ctx.pollMs ?? 1000);
    const t = hop(root, next, ctx.headers);
    const r = await f(t.url, { headers: t.headers, signal: AbortSignal.timeout(ctx.signalMs ?? 60_000) });
    if (!r.ok) throw new Error(vlError(r.status, await r.text()));
    if (!/json/i.test(r.headers.get('content-type') ?? '')) return Buffer.from(await r.arrayBuffer());
    job = await r.json();
  }
}

const abs = (root: string, url: string): string => (/^https?:/i.test(url) ? url : `${new URL(root).origin}${url.startsWith('/') ? '' : '/'}${url}`);

/** An address the service names: the API key goes only to the service's own host — never to another origin it points at. */
function hop(root: string, url: string, headers: Record<string, string> | undefined): { url: string; headers: Record<string, string> | undefined } {
  const full = abs(root, url);
  return { url: full, headers: new URL(full).origin === new URL(root).origin ? headers : undefined };
}

async function download(ctx: VlCtx, url: string): Promise<Buffer> {
  const t = hop(apiRoot(ctx.base), url, ctx.headers);
  const r = await (ctx.fetch ?? fetch)(t.url, { headers: t.headers, signal: AbortSignal.timeout(ctx.signalMs ?? 60_000) });
  if (!r.ok) throw new Error(vlError(r.status, await r.text()));
  return Buffer.from(await r.arrayBuffer());
}

export interface VlTranscript {
  text: string;
  segments: { start: number; end: number; text: string }[];
}

/** The text and phrases out of a transcription record. */
export function vlParseTranscript(j: unknown): VlTranscript | null {
  const root = (pick(j, ['transcription', 'result', 'data']) as unknown) ?? j;
  const segs = pick(root, ['segments']) ?? pick(j, ['segments']);
  // times come in milliseconds (`start_ms`); a plain `start` is taken as seconds
  const sec = (s: unknown, ms: string[], plain: string[]): number => {
    const m = Number(pick(s, ms));
    if (pick(s, ms) !== undefined && Number.isFinite(m)) return m / 1000;
    return Number(pick(s, plain));
  };
  const segments = (Array.isArray(segs) ? segs : [])
    .map((s) => ({ start: sec(s, ['start_ms', 'startMs'], ['start', 'startTime', 'start_time']), end: sec(s, ['end_ms', 'endMs'], ['end', 'endTime', 'end_time']), text: String(pick(s, ['text']) ?? '').trim() }))
    .filter((s) => Number.isFinite(s.start) && s.text)
    .map((s) => ({ ...s, end: Number.isFinite(s.end) ? s.end : s.start }));
  let text = String(pick(root, ['text', 'transcript']) ?? pick(j, ['text', 'transcript']) ?? '').trim();
  if (!text && segments.length) text = segments.map((s) => s.text).join(' ');
  return text || segments.length ? { text, segments } : null;
}

/** Audio → text: upload, then poll the transcription until it is ready. */
export async function vlTranscribe(ctx: VlCtx, p: { data: Buffer; mime: string; fileName: string; language?: string }): Promise<VlTranscript> {
  const f = ctx.fetch ?? fetch;
  const root = apiRoot(ctx.base);
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(p.data)], { type: p.mime }), p.fileName);
  form.append('language', p.language || 'auto');
  const res = await f(`${root}/stt`, { method: 'POST', headers: { ...ctx.headers, 'idempotency-key': randomUUID() }, body: form, signal: AbortSignal.timeout(ctx.signalMs ?? 60_000) });
  if (!res.ok) throw new Error(vlError(res.status, await res.text()));
  let rec: unknown = await res.json();
  const id = String(pick(rec, ['id', 'transcriptionId', 'transcription_id']) ?? pick(pick(rec, ['transcription', 'data']), ['id']) ?? '');
  const until = Date.now() + (ctx.maxWaitMs ?? 120_000);
  for (;;) {
    const status = String(pick(rec, ['status', 'state']) ?? pick(pick(rec, ['transcription', 'data']), ['status']) ?? '').toLowerCase();
    if (/fail|error|cancel/.test(status)) throw new Error(`Recognition failed: ${String(pick(rec, ['error', 'message']) ?? status)}`.slice(0, 240));
    const done = vlParseTranscript(rec);
    if (done && (!status || /done|complete|succe|ready|finish/.test(status))) return done;
    if (!id || Date.now() > until) throw new Error('VoiceLab did not finish the recognition in time.');
    await sleep(ctx.pollMs ?? 1000);
    const r = await f(`${root}/stt/transcriptions/${encodeURIComponent(id)}`, { headers: ctx.headers, signal: AbortSignal.timeout(ctx.signalMs ?? 60_000) });
    if (!r.ok) throw new Error(vlError(r.status, await r.text()));
    rec = await r.json();
  }
}

export interface VlVoice {
  id: string;
  name: string;
  language?: string;
}

/** The voice catalog (`GET /v1/voices`), whatever envelope it comes in. */
export async function vlVoices(ctx: VlCtx): Promise<VlVoice[]> {
  const r = await (ctx.fetch ?? fetch)(`${apiRoot(ctx.base)}/voices`, { headers: ctx.headers, signal: AbortSignal.timeout(ctx.signalMs ?? 30_000) });
  if (!r.ok) throw new Error(vlError(r.status, await r.text()));
  const j: unknown = await r.json();
  const list = Array.isArray(j) ? j : ((pick(j, ['voices', 'data', 'items', 'results']) as unknown[]) ?? []);
  return (Array.isArray(list) ? list : [])
    .map((v) => ({ id: String(pick(v, ['voiceId', 'voice_id', 'id']) ?? ''), name: String(pick(v, ['name', 'displayName', 'display_name', 'title']) ?? ''), language: pick(v, ['language', 'lang', 'locale']) as string | undefined }))
    .filter((v) => v.id)
    .map((v) => ({ ...v, name: v.name || v.id }));
}

/** WAV → Opus (Telegram voice) or MP3 through ffmpeg; null when ffmpeg is not there or fails (the caller then keeps the WAV). */
export function convertAudio(wav: Buffer, to: 'opus' | 'mp3'): Promise<Buffer | null> {
  const args = to === 'opus' ? ['-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg'] : ['-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3'];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...args, 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const out: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      resolve(code === 0 && buf.length > 0 ? buf : null);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(wav);
  });
}
