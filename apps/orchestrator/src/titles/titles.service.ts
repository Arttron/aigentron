import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ProvidersService } from '../providers/providers.service';
import { SettingsService } from '../settings/settings.service';
import { chatOnce, type ChatEndpoint } from './simple-chat';
import { TITLE_SYSTEM, buildTitleInput, cleanTitle } from './title-core';

export interface TitleConfig {
  enabled: boolean;
  /** Empty = the default provider (or the first one that can be called directly). */
  provider: string;
  /** Empty = a small model for the provider's kind (Claude Haiku) or the provider's own default. */
  model: string;
}

/** Small, cheap models per provider kind — a title is a few words, it never needs a big model. */
const SMALL_MODEL: Record<string, string> = { anthropic: 'claude-haiku-4-5-20251001' };

/**
 * Names tasks from their context with a small model (Settings → General → Task titles). Best effort and silent: without a provider that can be
 * called directly (a subscription login cannot), or when the call fails, the task simply keeps its first-line name.
 */
@Injectable()
export class TitlesService {
  private readonly logger = new Logger(TitlesService.name);
  private cache: { mtime: number; cfg: TitleConfig } | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly providers: ProvidersService,
    private readonly settings: SettingsService,
  ) {}

  private get file(): string {
    return join(this.config.secretsDir, 'titles.json');
  }

  get(): TitleConfig {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<TitleConfig>;
      return { enabled: j.enabled !== false, provider: typeof j.provider === 'string' ? j.provider : '', model: typeof j.model === 'string' ? j.model : '' };
    } catch {
      return { enabled: true, provider: '', model: '' };
    }
  }

  save(input: Partial<TitleConfig>): TitleConfig {
    const cfg: TitleConfig = { enabled: input.enabled !== false, provider: String(input.provider ?? '').trim(), model: String(input.model ?? '').trim().slice(0, 120) };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    return cfg;
  }

  /** The endpoint to name tasks with, or null when no provider can be called directly. */
  private async endpoint(cfg: TitleConfig): Promise<(ChatEndpoint & { provider: string }) | null> {
    const names: string[] = [];
    if (cfg.provider) names.push(cfg.provider);
    else {
      const def = await this.settings.defaultProvider().catch(() => '');
      if (def) names.push(def);
      for (const p of await this.providers.list().catch(() => [])) if (!names.includes(p.name)) names.push(p.name);
    }
    for (const name of names) {
      try {
        const row = await this.providers.get(name);
        const model = cfg.model || SMALL_MODEL[row.kind ?? ''] || '';
        const ep = await this.providers.chatEndpoint(name, model || undefined);
        if (ep.model) return { ...ep, provider: name };
      } catch {
        /* a subscription login, no key, no model — try the next one */
      }
    }
    return null;
  }

  /** A title for the given context, or null (disabled, no usable provider, an unusable reply, an error). */
  async suggest(ctx: { prompt: string; attachments?: string[]; agent?: string | null; answer?: string | null }): Promise<string | null> {
    const cfg = this.get();
    if (!cfg.enabled) return null;
    try {
      const ep = await this.endpoint(cfg);
      if (!ep) return null;
      const raw = await chatOnce(ep, { system: TITLE_SYSTEM, user: buildTitleInput(ctx) });
      return cleanTitle(raw);
    } catch (e) {
      this.logger.debug(`title generation failed: ${(e as Error).message.slice(0, 120)}`);
      return null;
    }
  }

  /**
   * On-demand translation for display (a discussion between agents is held in terse English to save tokens; the person can translate a message
   * when they want to read it). Uses the same small model as the titles. Never called automatically.
   */
  async translate(text: string, to: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    const src = String(text ?? '').trim().slice(0, 4000);
    const lang = String(to ?? '').trim().slice(0, 40) || 'English';
    if (!src) return { ok: false, error: 'Nothing to translate.' };
    try {
      const ep = await this.endpoint({ ...this.get(), enabled: true });
      if (!ep) return { ok: false, error: 'No provider can be called directly (subscription logins cannot). Add one with an API key in Settings → Providers.' };
      const out = await chatOnce(ep, {
        system: `Translate the user's text into the language with this code or name: ${lang}. Keep names, numbers, code, file paths and Markdown as they are. Output only the translation.`,
        user: src,
        maxTokens: 1500,
        timeoutMs: 40_000,
      });
      return out ? { ok: true, text: out } : { ok: false, error: 'The model returned nothing.' };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 160) };
    }
  }

  /** Settings → "Try it": the title for a sample request, with the error spelled out. */
  async test(prompt: string): Promise<{ ok: boolean; title?: string; provider?: string; error?: string }> {
    const cfg = this.get();
    try {
      const ep = await this.endpoint({ ...cfg, enabled: true });
      if (!ep) return { ok: false, error: 'No provider can be called directly (subscription logins cannot). Add one with an API key, or pick it here.' };
      const raw = await chatOnce(ep, { system: TITLE_SYSTEM, user: buildTitleInput({ prompt }) });
      const title = cleanTitle(raw);
      return title ? { ok: true, title, provider: ep.provider } : { ok: false, provider: ep.provider, error: `The model answered, but not with a usable title: "${raw.slice(0, 80)}"` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
