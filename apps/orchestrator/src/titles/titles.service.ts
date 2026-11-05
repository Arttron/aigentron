import { join } from 'node:path';
import { SecretJsonFile } from '../security/secret-json-file';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ProvidersService } from '../providers/providers.service';
import { SettingsService } from '../settings/settings.service';
import { askClaudeCli } from '../provider-login/claude-probe';
import { chatOnce, type ChatEndpoint } from './simple-chat';
import { TITLE_SYSTEM, buildTitleInput, cleanTitle } from './title-core';

export interface TitleConfig {
  enabled: boolean;
  /** Empty = the default provider (or the first one that can be called directly). */
  provider: string;
  /** Empty = a small model for the provider's kind (Claude Haiku) or the provider's own default. */
  model: string;
}

/** How many providers one title may try, how long each may take, and how long one that failed is left alone. */
const MAX_ATTEMPTS = 4;
const ATTEMPT_TIMEOUT_MS = 12_000;
const COOLDOWN_MS = 5 * 60_000;
/** The whole question (all providers together) may take this long; a translation is longer text and gets more. */
const TOTAL_BUDGET_MS = 30_000;

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

  private store?: SecretJsonFile<TitleConfig>;
  private get json(): SecretJsonFile<TitleConfig> {
    return (this.store ??= new SecretJsonFile<TitleConfig>(this.file, {
      missing: { enabled: true, provider: '', model: '' },
      parse: (raw) => {
        const j = raw as Partial<TitleConfig>;
        return { enabled: j.enabled !== false, provider: typeof j.provider === 'string' ? j.provider : '', model: typeof j.model === 'string' ? j.model : '' };
      },
    }));
  }

  get(): TitleConfig {
    return this.json.read();
  }

  save(input: Partial<TitleConfig>): TitleConfig {
    const cfg: TitleConfig = { enabled: input.enabled !== false, provider: String(input.provider ?? '').trim(), model: String(input.model ?? '').trim().slice(0, 120) };
    this.json.write(cfg);
    return cfg;
  }

  /**
   * A provider the person picked that is a Claude SUBSCRIPTION (an OAuth token cannot be called over HTTP): the small question goes through
   * the official CLI instead — a few seconds slower, on the subscription. Null for every other provider.
   */
  private async subscriptionChoice(cfg: TitleConfig): Promise<{ provider: string; token: string; model: string } | null> {
    if (!cfg.provider) return null;
    try {
      const row = await this.providers.get(cfg.provider);
      if (row.authMode !== 'oauth-token' || (row.kind ?? 'anthropic') !== 'anthropic' || !row.secret) return null;
      return { provider: cfg.provider, token: row.secret, model: cfg.model || SMALL_MODEL.anthropic! };
    } catch {
      return null;
    }
  }

  /** One short completion for the configured provider: HTTP when it can be called directly, the Claude CLI for a subscription. */
  private async complete(cfg: TitleConfig, o: { system: string; user: string; maxTokens?: number; timeoutMs?: number; budgetMs?: number }, usable: (text: string) => boolean = (t) => t.length > 0): Promise<{ text: string; provider: string } | null> {
    const sub = await this.subscriptionChoice(cfg);
    if (sub) {
      const r = await askClaudeCli(sub.token, sub.model, o.user, o.system, Math.max(o.timeoutMs ?? 0, 45_000));
      if (!r.ok) throw new Error(r.error ?? 'the Claude CLI failed');
      return { text: (r.reply ?? '').trim(), provider: sub.provider };
    }
    // Every provider that can be called directly, in order: the one that is down (a local model that is not running, a key that was revoked, a rate limit)
    // is skipped for a few minutes, and the next one answers. Only when none does, the error is raised.
    const candidates = await this.endpoints(cfg);
    if (!candidates.length) return null;
    const fresh = candidates.filter((c) => (this.cooldown.get(c.provider) ?? 0) <= Date.now());
    let lastError: Error | null = null;
    // one budget for the whole question, not for each provider: a person waiting on "Try it" must not wait for four slow ones in a row
    const deadline = Date.now() + (o.budgetMs ?? TOTAL_BUDGET_MS);
    for (const ep of (fresh.length ? fresh : candidates).slice(0, MAX_ATTEMPTS)) {
      const left = deadline - Date.now();
      if (left < 2_000 && lastError) break;
      let text: string;
      try {
        text = await chatOnce(ep, { ...o, timeoutMs: Math.max(2_000, Math.min(o.timeoutMs ?? ATTEMPT_TIMEOUT_MS, left)) });
      } catch (e) {
        // a provider that cannot be reached / refuses (down, revoked key, rate limit) is left alone for a few minutes
        lastError = e as Error;
        this.cooldown.set(ep.provider, Date.now() + COOLDOWN_MS);
        this.logger.debug(`titles: ${ep.provider} did not answer (${lastError.message.slice(0, 100)}) — trying the next provider`);
        continue;
      }
      // an empty reply (a model that only "thought") or one that is no title at all is a miss too: the next provider gets the question — but the
      // provider itself is healthy, so it is not put aside
      if (!usable(text)) {
        lastError = new Error(text ? `unusable reply "${text.slice(0, 40)}"` : 'an empty reply');
        continue;
      }
      this.cooldown.delete(ep.provider);
      return { text, provider: ep.provider };
    }
    throw lastError ?? new Error('no provider answered');
  }

  /** Providers that did not answer lately → when to try them again. */
  private readonly cooldown = new Map<string, number>();
  private lastWarnAt = 0;

  /** The endpoints to name tasks with, in the order to try them: the chosen provider alone, else the default one first and then every other that can be called directly. */
  private async endpoints(cfg: TitleConfig): Promise<(ChatEndpoint & { provider: string })[]> {
    const out: (ChatEndpoint & { provider: string })[] = [];
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
        if (ep.model) out.push({ ...ep, provider: name });
      } catch {
        /* a subscription login, no key, no model — try the next one */
      }
    }
    return out;
  }

  /** A title for the given context, or null (disabled, no usable provider, an unusable reply, an error). */
  async suggest(ctx: { prompt: string; attachments?: string[]; agent?: string | null; answer?: string | null }): Promise<string | null> {
    const cfg = this.get();
    if (!cfg.enabled) return null;
    try {
      const r = await this.complete(cfg, { system: TITLE_SYSTEM, user: buildTitleInput(ctx) }, (t) => Boolean(cleanTitle(t)));
      return r ? cleanTitle(r.text) : null;
    } catch (e) {
      // said once in a while (not for every task): a person whose titles stay as the first line needs to find the reason in the log
      if (Date.now() - this.lastWarnAt > 10 * 60_000) {
        this.lastWarnAt = Date.now();
        this.logger.warn(`Task titles: no provider could name a task (${(e as Error).message.slice(0, 160)}). Settings → General → Task titles → Try it shows the details.`);
      }
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
      const r = await this.complete(
        { ...this.get(), enabled: true },
        {
          system: `Translate the user's text into the language with this code or name: ${lang}. Keep names, numbers, code, file paths and Markdown as they are. Output only the translation.`,
          user: src,
          maxTokens: 1500,
          timeoutMs: 40_000,
          budgetMs: 90_000,
        },
      );
      if (!r) return { ok: false, error: 'No provider can be called directly (subscription logins cannot). Add one with an API key in Settings → Providers.' };
      return r.text ? { ok: true, text: r.text } : { ok: false, error: 'The model returned nothing.' };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 160) };
    }
  }

  /** Settings → "Try it": the title for a sample request, with the error spelled out. */
  async test(prompt: string): Promise<{ ok: boolean; title?: string; provider?: string; error?: string }> {
    const cfg = this.get();
    try {
      const r = await this.complete({ ...cfg, enabled: true }, { system: TITLE_SYSTEM, user: buildTitleInput({ prompt }) }, (t) => Boolean(cleanTitle(t)));
      if (!r) return { ok: false, error: 'No provider can be called directly (a Codex login cannot). Add one with an API key, pick a Claude subscription here, or pick another provider.' };
      const title = cleanTitle(r.text);
      return title ? { ok: true, title, provider: r.provider } : { ok: false, provider: r.provider, error: `The model answered, but not with a usable title: "${r.text.slice(0, 80)}"` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
