import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { SecretJsonFile } from '../security/secret-json-file';
import { BadRequestException, Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ProvidersService } from '../providers/providers.service';

export interface VisionConfig {
  provider: string;
  /** Empty = the provider's default model. */
  model: string;
}

export interface LookImage {
  data: Buffer;
  mime: string;
}

const TIMEOUT_MS = 90_000;

const crcTable = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A small solid-colour PNG (for the "can the model see?" test). */
export function solidPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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
 * The agents' "eyes": a configured vision-capable model (Settings → Vision) that looks at an image or video frames and answers a
 * question about them. It lets ANY agent — even one running on a text-only model — use photos and video. The provider comes from
 * the registry (Anthropic, OpenAI, DeepSeek-style, or a local Ollama / OpenAI-compatible server); its key stays there.
 */
@Injectable()
export class VisionService {

  constructor(
    private readonly config: AppConfigService,
    private readonly providers: ProvidersService,
  ) {}

  private get file(): string {
    return join(this.config.secretsDir, 'vision.json');
  }

  private store?: SecretJsonFile<VisionConfig | null>;
  private get json(): SecretJsonFile<VisionConfig | null> {
    return (this.store ??= new SecretJsonFile<VisionConfig | null>(this.file, {
      missing: null,
      parse: (raw) => {
        const j = raw as Partial<VisionConfig>;
        return typeof j.provider === 'string' && j.provider ? { provider: j.provider, model: typeof j.model === 'string' ? j.model : '' } : null;
      },
    }));
  }

  get(): VisionConfig | null {
    return this.json.read();
  }

  ready(): boolean {
    return this.get() !== null;
  }

  async save(input: { provider?: unknown; model?: unknown } | null): Promise<VisionConfig | null> {
    if (!input || !input.provider) {
      this.write(null);
      return null;
    }
    const provider = String(input.provider).trim();
    const model = typeof input.model === 'string' ? input.model.trim().slice(0, 120) : '';
    try {
      await this.providers.chatEndpoint(provider);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const cfg = { provider, model };
    this.write(cfg);
    return cfg;
  }

  private write(cfg: VisionConfig | null): void {
    this.json.write(cfg ?? {});
  }

  /** Ask the vision model about up to a few images. Returns its answer. */
  async describe(images: LookImage[], question: string, own?: VisionConfig): Promise<string> {
    // The configured vision model; without one, the model this agent is running on — when it is a cloud API model (those can see images).
    let cfg = this.get();
    if (!cfg && own?.provider && (await this.ownCanSee(own))) cfg = own;
    if (!cfg) throw new Error('No vision model is set up. An operator can choose one in Settings → Vision (any provider whose model can see images) — the model this agent runs on cannot be used for it.');
    const ep = await this.providers.chatEndpoint(cfg.provider, cfg.model);
    const model = ep.model;
    if (!model) throw new Error(`Provider "${cfg.provider}" has no default model — choose a model in Settings → Vision.`);
    const q = question.trim() || 'Describe what you see in detail: objects, text, measurements, condition.';
    const body =
      ep.style === 'anthropic'
        ? { model, max_tokens: 1200, messages: [{ role: 'user', content: [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data.toString('base64') } })), { type: 'text', text: q }] }] }
        : { model, max_tokens: 1200, messages: [{ role: 'user', content: [{ type: 'text', text: q }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data.toString('base64')}` } }))] }] };
    const res = await fetch(ep.url, { method: 'POST', headers: ep.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new Error(`The vision model said: ${apiError(res.status, text)}`);
    const j = JSON.parse(text) as { content?: { type: string; text?: string }[]; choices?: { message?: { content?: string } }[] };
    const answer = ep.style === 'anthropic' ? (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') : (j.choices?.[0]?.message?.content ?? '');
    if (!answer.trim()) throw new Error('The vision model returned no text.');
    return answer.trim();
  }

  /** Can the agent's own model be used as the eyes? Only a direct API provider of a kind whose models take images (Anthropic, OpenAI-style). */
  private async ownCanSee(own: VisionConfig): Promise<boolean> {
    try {
      const p = await this.providers.get(own.provider);
      if (p.kind !== 'anthropic' && p.kind !== 'openai') return false;
      await this.providers.chatEndpoint(own.provider, own.model); // throws for subscription logins
      return true;
    } catch {
      return false;
    }
  }

  /** Settings → Vision "Test": show it a red square and see whether it says so. */
  async test(): Promise<{ ok: boolean; answer?: string; error?: string }> {
    try {
      const answer = await this.describe([{ data: solidPng(32, [220, 30, 30]), mime: 'image/png' }], 'What colour is this image? Answer with one word.');
      return { ok: /red|красн|rouge|rot/i.test(answer), answer: answer.slice(0, 120), ...(/red|красн|rouge|rot/i.test(answer) ? {} : { error: 'It answered, but not "red" — this model may not be able to see images.' }) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
