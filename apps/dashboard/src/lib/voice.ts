import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from './config';

export interface VoiceSettings {
  stt: { provider: string; model: string; language: string } | null;
  tts: { provider: string; model: string; voice: string; maxChars: number } | null;
  sttReady: boolean;
  ttsReady: boolean;
}

const CHANGED = 'lds-voice-changed';
let cached: Promise<VoiceSettings> | null = null;

export async function loadVoice(force = false): Promise<VoiceSettings> {
  if (!cached || force) {
    cached = fetch(`${API_BASE}/voice`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<VoiceSettings>) : Promise.reject(new Error(String(r.status)))))
      .catch(() => ({ stt: null, tts: null, sttReady: false, ttsReady: false }) as VoiceSettings);
  }
  return cached;
}

/** What voice features are set up — the UI shows the mic / speaker only when they work. */
export function useVoice(): VoiceSettings | null {
  const [v, setV] = useState<VoiceSettings | null>(null);
  useEffect(() => {
    let live = true;
    const load = (force = false) => void loadVoice(force).then((x) => live && setV(x));
    load();
    const on = () => load(true);
    window.addEventListener(CHANGED, on);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, on);
    };
  }, []);
  return v;
}

export const voiceChanged = () => window.dispatchEvent(new Event(CHANGED));

async function failure(r: Response): Promise<Error> {
  const j = (await r.json().catch(() => ({}))) as { message?: string | string[] };
  return new Error(Array.isArray(j.message) ? j.message.join('; ') : (j.message ?? `${r.status} ${r.statusText}`));
}

export const voiceApi = {
  async save(body: unknown): Promise<VoiceSettings> {
    const r = await fetch(`${API_BASE}/voice`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw await failure(r);
    voiceChanged();
    return r.json() as Promise<VoiceSettings>;
  },
  async test(): Promise<{ tts: { ok: boolean; error?: string; bytes?: number } | null; stt: { ok: boolean; error?: string; heard?: string } | null }> {
    const r = await fetch(`${API_BASE}/voice/test`, { method: 'POST' });
    if (!r.ok) throw await failure(r);
    return r.json();
  },
  async transcribe(blob: Blob): Promise<string> {
    const r = await fetch(`${API_BASE}/voice/transcribe`, { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
    if (!r.ok) throw await failure(r);
    return ((await r.json()) as { text: string }).text;
  },
  async speak(text: string): Promise<Blob> {
    const r = await fetch(`${API_BASE}/voice/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) throw await failure(r);
    return r.blob();
  },
};

// ---- per-browser preferences -----------------------------------------------------------------------------------------------------

const PREF_EVENT = 'lds-voice-pref';
export function usePref(key: string): [boolean, (v: boolean) => void] {
  const read = () => {
    try {
      return window.localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  };
  const [v, setV] = useState(read);
  useEffect(() => {
    const on = () => setV(read());
    window.addEventListener(PREF_EVENT, on);
    return () => window.removeEventListener(PREF_EVENT, on);
    // eslint-disable-next-line
  }, [key]);
  const set = useCallback(
    (next: boolean) => {
      try {
        if (next) window.localStorage.setItem(key, '1');
        else window.localStorage.removeItem(key);
      } catch {
        /* not persisted */
      }
      setV(next);
      window.dispatchEvent(new Event(PREF_EVENT));
    },
    [key],
  );
  return [v, set];
}
/** Read new answers aloud (needs text-to-speech). */
export const useAutoSpeak = () => usePref('lds-voice-autospeak');
/** Voice-only chat: the text box is replaced by an indicator, you just talk. */
export const useVoiceOnly = () => usePref('lds-voice-only');
/** In voice-only mode, start listening again after each spoken answer. */
export const useKeepListening = () => usePref('lds-voice-keep');

// ---- recording -------------------------------------------------------------------------------------------------------------------

export const micSupported = (): boolean => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

function pickMime(): string {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return '';
}

export interface RecordResult {
  blob: Blob;
  /** Whether any speech was heard (silence-only recordings are not worth transcribing). */
  hadSpeech: boolean;
  ms: number;
}

/**
 * Microphone recorder with a simple voice-activity detector: it can stop on its own after a pause that follows speech, and it
 * reports the input level (0–1) for the on-screen indicator. Needs HTTPS or localhost (browser rule).
 */
export class Recorder {
  private stream?: MediaStream;
  private rec?: MediaRecorder;
  private ctx?: AudioContext;
  private raf = 0;
  private chunks: Blob[] = [];
  private started = 0;
  private heard = false;
  private lastVoice = 0;
  private finish?: (r: RecordResult) => void;

  constructor(
    private readonly opts: { onLevel?: (level: number) => void; autoStopAfterSilenceMs?: number; maxMs?: number; onAutoStop?: () => void } = {},
  ) {}

  async start(): Promise<void> {
    if (!window.isSecureContext) throw new Error('The microphone works only over HTTPS or on localhost.');
    if (!micSupported()) throw new Error('This browser cannot record audio.');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).catch((e: Error) => {
      throw new Error(e.name === 'NotAllowedError' ? 'Microphone access was denied — allow it in the browser.' : `No microphone: ${e.message}`);
    });
    const mime = pickMime();
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.rec?.mimeType || mime || 'audio/webm' });
      this.finish?.({ blob, hadSpeech: this.heard, ms: Date.now() - this.started });
    };
    // level meter + voice-activity detection
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    this.started = Date.now();
    this.lastVoice = this.started;
    this.heard = false;
    this.rec.start(250);
    const silenceMs = this.opts.autoStopAfterSilenceMs ?? 0;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const b of buf) sum += ((b - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      this.opts.onLevel?.(Math.min(1, rms * 4));
      const now = Date.now();
      if (rms > 0.03) {
        this.heard = true;
        this.lastVoice = now;
      }
      if (silenceMs && this.heard && now - this.lastVoice > silenceMs) return void this.opts.onAutoStop?.();
      if (this.opts.maxMs && now - this.started > this.opts.maxMs) return void this.opts.onAutoStop?.();
      // nobody spoke at all for a while: give up quietly
      if (silenceMs && !this.heard && now - this.started > 8000) return void this.opts.onAutoStop?.();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): Promise<RecordResult> {
    cancelAnimationFrame(this.raf);
    return new Promise((resolve) => {
      this.finish = (r) => {
        this.release();
        resolve(r);
      };
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
      else this.finish({ blob: new Blob([]), hadSpeech: false, ms: 0 });
    });
  }

  cancel(): void {
    cancelAnimationFrame(this.raf);
    this.finish = undefined;
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.stream = undefined;
    this.ctx = undefined;
  }
}

// ---- playback --------------------------------------------------------------------------------------------------------------------

let audio: HTMLAudioElement | null = null;
let actx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let raf = 0;
let stopCurrent: (() => void) | null = null;

function player(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
  }
  return audio;
}

/**
 * Call from a click/tap handler once: mobile browsers only let a page play sound after a user gesture, so we "unlock" the shared
 * audio element then (a tiny silent clip), and later answers can start by themselves.
 */
export function unlockAudio(): void {
  const a = player();
  a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
  void a.play().catch(() => undefined);
}

/** Speak `text` (server-side text-to-speech). Resolves when playback ends or is stopped. `onLevel` gets the loudness (0–1). */
export async function speakText(text: string, onLevel?: (level: number) => void): Promise<void> {
  stopSpeaking();
  const blob = await voiceApi.speak(text);
  const url = URL.createObjectURL(blob);
  const a = player();
  a.src = url;
  try {
    if (!actx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      actx = new Ctx();
      analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      actx.createMediaElementSource(a).connect(analyser);
      analyser.connect(actx.destination);
    }
    void actx.resume();
  } catch {
    analyser = null; // no level meter — playback still works
  }
  await new Promise<void>((resolve, reject) => {
    const buf = analyser ? new Uint8Array(analyser.fftSize) : null;
    const done = () => {
      cancelAnimationFrame(raf);
      onLevel?.(0);
      a.onended = a.onerror = null;
      stopCurrent = null;
      URL.revokeObjectURL(url);
    };
    stopCurrent = () => {
      done();
      a.pause();
      resolve();
    };
    a.onended = () => {
      done();
      resolve();
    };
    a.onerror = () => {
      done();
      reject(new Error('Could not play the audio.'));
    };
    if (analyser && buf && onLevel) {
      const tick = () => {
        analyser!.getByteTimeDomainData(buf);
        let sum = 0;
        for (const b of buf) sum += ((b - 128) / 128) ** 2;
        onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    a.play().catch((e: Error) => {
      done();
      reject(new Error(e.name === 'NotAllowedError' ? 'The browser blocked playback — tap the 🔊 button once.' : e.message));
    });
  });
}

export function stopSpeaking(): void {
  stopCurrent?.();
}
