import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ProvidersService } from '../providers/providers.service';
import { EMPTY_VOICE, MAX_AUDIO_BYTES, audioFileName, parseVoiceConfig, speechText, type VoiceConfig } from './voice-core';

const TIMEOUT_MS = 60_000;

/** A short, human message from an OpenAI-style error body. */
function apiError(status: number, text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const m = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message);
    if (m) return `${m}`.slice(0, 240);
  } catch {
    /* not JSON */
  }
  return `HTTP ${status}${text ? `: ${text.slice(0, 160)}` : ''}`;
}

/**
 * Speech in and out through OpenAI-compatible audio endpoints (`/audio/transcriptions`, `/audio/speech`): the same code serves
 * OpenAI, Groq and a local Whisper/TTS server — only the provider's Base URL and key differ. The settings (which provider and
 * model for each half) live in `<secretsDir>/voice.json`; keys stay in the provider registry.
 */
@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private cache: { mtime: number; config: VoiceConfig } = { mtime: -1, config: EMPTY_VOICE };

  constructor(
    private readonly config: AppConfigService,
    private readonly providers: ProvidersService,
  ) {}

  private get file(): string {
    return join(this.config.secretsDir, 'voice.json');
  }

  get(): VoiceConfig {
    let mtime = 0;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      this.cache = { mtime: 0, config: EMPTY_VOICE };
      return EMPTY_VOICE;
    }
    if (mtime !== this.cache.mtime) {
      try {
        this.cache = { mtime, config: parseVoiceConfig(JSON.parse(readFileSync(this.file, 'utf8'))).config ?? EMPTY_VOICE };
      } catch {
        this.cache = { mtime, config: EMPTY_VOICE };
      }
    }
    return this.cache.config;
  }

  sttReady(): boolean {
    return this.get().stt !== null;
  }
  ttsReady(): boolean {
    return this.get().tts !== null;
  }

  /** Validate (shape + that each provider can serve audio) and store. */
  async save(input: unknown): Promise<VoiceConfig> {
    const parsed = parseVoiceConfig(input);
    if (parsed.error !== undefined) throw new BadRequestException(parsed.error);
    const c = parsed.config;
    for (const [label, half] of [['Speech-to-text', c.stt], ['Text-to-speech', c.tts]] as const) {
      if (!half) continue;
      try {
        await this.providers.audioEndpoint(half.provider);
      } catch (e) {
        throw new BadRequestException(`${label}: ${(e as Error).message}`);
      }
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.cache = { mtime: -1, config: EMPTY_VOICE };
    return c;
  }

  /** Speech → text. */
  async transcribe(data: Buffer, mime?: string): Promise<string> {
    const stt = this.get().stt;
    if (!stt) throw new BadRequestException('Speech recognition is not set up — Settings → Voice.');
    if (!data.length) throw new BadRequestException('The recording is empty.');
    if (data.length > MAX_AUDIO_BYTES) throw new BadRequestException('The recording is too large (max 25 MB).');
    const { base, headers } = await this.providers.audioEndpoint(stt.provider).catch((e) => {
      throw new BadRequestException((e as Error).message);
    });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: mime || 'audio/ogg' }), audioFileName(mime));
    form.append('model', stt.model);
    form.append('response_format', 'json');
    if (stt.language) form.append('language', stt.language);
    const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e) => {
      throw new BadRequestException(`Could not reach the speech service: ${(e as Error).message}`);
    });
    const text = await res.text();
    if (!res.ok) throw new BadRequestException(`Speech recognition failed: ${apiError(res.status, text)}`);
    try {
      return String((JSON.parse(text) as { text?: string }).text ?? '').trim();
    } catch {
      return text.trim();
    }
  }

  /**
   * Text → speech. `format`: "opus" for Telegram voice messages, "mp3" for browsers. Markdown is turned into speakable text and
   * long answers are cut at a sentence (the caller still sends the full text).
   */
  async speak(markdown: string, format: 'opus' | 'mp3' = 'mp3'): Promise<{ audio: Buffer; mime: string; truncated: boolean }> {
    const tts = this.get().tts;
    if (!tts) throw new BadRequestException('Speech synthesis is not set up — Settings → Voice.');
    const { text, truncated } = speechText(markdown, tts.maxChars);
    if (!text) throw new BadRequestException('Nothing to read aloud.');
    const { base, headers } = await this.providers.audioEndpoint(tts.provider).catch((e) => {
      throw new BadRequestException((e as Error).message);
    });
    const request = (fmt: string) =>
      fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model: tts.model, input: text, voice: tts.voice, response_format: fmt }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch((e) => {
        throw new BadRequestException(`Could not reach the speech service: ${(e as Error).message}`);
      });
    let res = await request(format);
    let sent: string = format;
    if (!res.ok && format === 'opus' && res.status === 400) {
      // A local server may not offer Opus — fall back to MP3 (the Telegram adapter then sends it as an audio file).
      res = await request('mp3');
      sent = 'mp3';
    }
    if (!res.ok) throw new BadRequestException(`Speech synthesis failed: ${apiError(res.status, await res.text())}`);
    return { audio: Buffer.from(await res.arrayBuffer()), mime: sent === 'opus' ? 'audio/ogg' : 'audio/mpeg', truncated };
  }

  /** Round trip for the settings page: say a phrase, then recognise it. Each half reports separately. */
  async test(): Promise<{ tts: { ok: boolean; error?: string; bytes?: number } | null; stt: { ok: boolean; error?: string; heard?: string } | null }> {
    const c = this.get();
    const out: Awaited<ReturnType<VoiceService['test']>> = { tts: null, stt: null };
    let audio: Buffer | null = null;
    let mime = 'audio/mpeg';
    if (c.tts) {
      try {
        const r = await this.speak('Hello! This is a voice test. One, two, three.', 'mp3');
        audio = r.audio;
        mime = r.mime;
        out.tts = { ok: true, bytes: r.audio.length };
      } catch (e) {
        out.tts = { ok: false, error: (e as Error).message };
      }
    }
    if (c.stt) {
      if (!audio) out.stt = { ok: false, error: 'To test recognition by itself, record a message in the dashboard (the 🎤 button).' };
      else
        try {
          out.stt = { ok: true, heard: await this.transcribe(audio, mime) };
        } catch (e) {
          out.stt = { ok: false, error: (e as Error).message };
        }
    }
    this.logger.log(`voice test: tts=${out.tts?.ok} stt=${out.stt?.ok}`);
    return out;
  }
}
