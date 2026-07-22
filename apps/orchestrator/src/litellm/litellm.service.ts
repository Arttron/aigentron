import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LitellmManagedService } from './litellm-managed.service';

/** A proxied route as shown in the dashboard (no raw secret — litellm encrypts). */
export interface LitellmRoute {
  /** The model_name litellm serves, e.g. `GPT/gpt-4o-mini`, `local-coder`. */
  modelName: string;
  /** Backend litellm forwards to, e.g. `openai/gpt-4o-mini`, `ollama_chat/…`. */
  backend: string | null;
  apiBase: string | null;
  /** True for routes the orchestrator manages (DB-registered via admin API). */
  managed: boolean;
}

/** Upstream API family → LiteLLM backend prefix. */
export type ProviderKind = 'anthropic' | 'openai' | 'deepseek' | 'ollama';
export const PROVIDER_KINDS: ProviderKind[] = ['anthropic', 'openai', 'deepseek', 'ollama'];

/** litellm_params that strip the agent's extended-thinking for non-Anthropic models. */
const NO_REASONING = {
  // The Claude agent sends extended-thinking, which litellm maps to OpenAI-style
  // reasoning params; non-reasoning models (gpt-4o…) reject them. Drop them.
  drop_params: true,
  additional_drop_params: ['reasoning_effort', 'reasoning', 'thinking'],
};

/** Encode `<provider>/<model>` — the model_name an agent requests via litellm. */
export function routeName(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Strip a leading `<name>/` a user pasted from the model picker. A gateway
 * provider lists litellm model_names (e.g. `ollama-local/local-coder`) and
 * picking one would otherwise bake the provider's own prefix into `model`,
 * which routeName then re-prefixes on every save. Repeat to undo compounding.
 */
export function stripSelfPrefix(name: string, model: string): string {
  const prefix = `${name}/`;
  let m = model;
  while (m.startsWith(prefix)) m = m.slice(prefix.length);
  return m;
}

/** Best-effort default kind from a base URL (the form pre-fills, user can change). */
export function defaultKind(baseUrl: string | null | undefined): ProviderKind {
  const u = (baseUrl ?? '').toLowerCase();
  if (!u || u.includes('api.anthropic.com') || u.includes('api.z.ai')) return 'anthropic';
  // Some vendors expose a dedicated Anthropic-protocol-compatible path
  // alongside their native one (e.g. DeepSeek's `.../anthropic` — real,
  // documented, not a guess) — prefer 'anthropic' whenever the URL itself
  // says so, regardless of which vendor it is.
  if (/\/anthropic\/?$/.test(u)) return 'anthropic';
  if (u.includes('api.deepseek.com')) return 'deepseek';
  if (u.includes('api.openai.com')) return 'openai';
  if (u.includes('11434') || u.includes('ollama')) return 'ollama';
  return 'openai';
}

/** Map a provider kind to its LiteLLM backend prefix + whether to drop reasoning. */
function backend(kind: string): { prefix: string; dropReasoning: boolean } {
  switch (kind) {
    case 'anthropic':
      return { prefix: 'anthropic', dropReasoning: false };
    case 'deepseek':
      return { prefix: 'deepseek', dropReasoning: true };
    case 'ollama':
      return { prefix: 'ollama_chat', dropReasoning: true };
    default:
      return { prefix: 'openai', dropReasoning: true };
  }
}

/**
 * Client for the LiteLLM proxy's admin API. The orchestrator registers an exact
 * route per (OpenAI-native provider, model) so agents — which only speak the
 * Anthropic protocol — can use them: `<provider>/<model>` → `openai/<model>`
 * with the provider's key. (An `openai/*` wildcard would defeat litellm's
 * per-model param dropping, so routes are exact.) Keys travel orchestrator→
 * litellm over the internal network and are stored encrypted by litellm
 * (STORE_MODEL_IN_DB); they never reach the browser or an agent.
 */
@Injectable()
export class LitellmService {
  private readonly logger = new Logger(LitellmService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly managed: LitellmManagedService,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.litellmMasterKey && this.config.litellmBaseUrl);
  }

  /**
   * True if a provider's baseUrl already targets the LiteLLM gateway itself.
   * Such a provider's `model` is a litellm model_name to use verbatim — we must
   * NOT wrap it in a `<provider>/<model>` route or register one, since that maps
   * `ollama_chat/<model>` back at litellm:4000 (a loop) and re-prefixing on every
   * save compounds (`ollama-local/ollama-local/…`).
   */
  isGatewayUrl(baseUrl: string | null | undefined): boolean {
    if (!baseUrl) return false;
    const norm = (u: string) => u.replace(/\/+$/, '').replace(/\/v1$/, '');
    return norm(baseUrl) === norm(this.config.litellmBaseUrl);
  }

  /**
   * True when a provider's `model` is a litellm model_name to use VERBATIM: its
   * baseUrl targets the gateway itself and it isn't ollama. Such a provider gets
   * no `<name>/<model>` route (registering one would loop litellm into itself)
   * and its model string goes to the agent as-is. Ollama is the exception — it
   * still registers a route forwarding to the real Ollama (ollamaEndpoint).
   * THE single decision point for route registration, model listing, and agent
   * env mapping — extend the rule here, never at a call site.
   */
  servesVerbatim(p: { baseUrl?: string | null; kind?: string | null }): boolean {
    return this.isGatewayUrl(p.baseUrl) && p.kind !== 'ollama';
  }

  /**
   * The Ollama endpoint an ollama route/picker should hit. A provider's baseUrl
   * points at the litellm gateway (or is blank), so fall back to the configured
   * native Ollama; honor baseUrl only when it's a real, non-gateway Ollama host.
   */
  ollamaEndpoint(baseUrl: string | null | undefined): string {
    return baseUrl && !this.isGatewayUrl(baseUrl) ? baseUrl.replace(/\/$/, '') : this.config.ollamaNativeUrl;
  }

  /** The model_names litellm currently serves (for a gateway provider's picker). */
  async listModelNames(): Promise<string[]> {
    if (!this.enabled) return [];
    const names = (await this.models().catch(() => [])).map((m) => m.model_name);
    return Array.from(new Set(names)).sort();
  }

  private async api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.config.litellmBaseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.litellmMasterKey}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  }

  private async models(): Promise<RawModel[]> {
    const res = await this.api('/model/info');
    if (!res.ok) return [];
    return ((await res.json()) as { data?: RawModel[] }).data ?? [];
  }

  /** All routes litellm currently serves (for the Settings display). */
  async listRoutes(): Promise<LitellmRoute[]> {
    if (!this.enabled) return [];
    try {
      return (await this.models()).map((m) => ({
        modelName: m.model_name,
        backend: m.litellm_params?.model ?? null,
        apiBase: m.litellm_params?.api_base ?? null,
        managed: Boolean(m.model_info?.db_model),
      }));
    } catch (e) {
      this.logger.warn(`listRoutes failed: ${(e as Error).message}`);
      return [];
    }
  }

  /** Register `<provider>/<model>` → `<backend>/<model>` (replacing any prior). */
  async registerRoute(
    provider: string,
    model: string,
    params: { kind: string; apiBase: string | null; apiKey: string; rpm?: number | null; tpm?: number | null },
  ): Promise<void> {
    if (!model) return;
    const name = routeName(provider, model);
    const { prefix, dropReasoning } = backend(params.kind);
    // Ollama routes must forward to the real Ollama, not the provider's baseUrl
    // (which is the litellm gateway → would loop litellm back into itself).
    const apiBase = params.kind === 'ollama' ? this.ollamaEndpoint(params.apiBase) : params.apiBase;
    if (this.config.litellmManaged) {
      await this.managed.registerRoute(name, `${prefix}/${model}`, { ...params, apiBase, dropReasoning });
      this.logger.log(`Registered managed LiteLLM route ${name} → ${prefix}/${model}`);
      return;
    }
    if (!this.enabled) return;
    await this.deleteByName(name);
    const body = {
      model_name: name,
      litellm_params: {
        model: `${prefix}/${model}`,
        ...(params.apiKey ? { api_key: params.apiKey } : {}),
        ...(apiBase ? { api_base: apiBase } : {}),
        // Per-provider rate caps — LiteLLM cools down + retries on 429 (see config).
        ...(params.rpm ? { rpm: params.rpm } : {}),
        ...(params.tpm ? { tpm: params.tpm } : {}),
        ...(dropReasoning ? NO_REASONING : {}),
      },
    };
    const res = await this.api('/model/new', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      throw new Error(`litellm /model/new failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    this.logger.log(`Registered LiteLLM route ${name} → ${prefix}/${model}`);
  }

  /** Register the route only if it isn't already present (run-time, per model). */
  async ensureRoute(
    provider: string,
    model: string,
    params: { kind: string; apiBase: string | null; apiKey: string; rpm?: number | null; tpm?: number | null },
  ): Promise<void> {
    if (!model) return;
    const name = routeName(provider, model);
    if (this.config.litellmManaged) {
      const { prefix, dropReasoning } = backend(params.kind);
      const apiBase = params.kind === 'ollama' ? this.ollamaEndpoint(params.apiBase) : params.apiBase;
      await this.managed.ensureRoute(name, `${prefix}/${model}`, { ...params, apiBase, dropReasoning });
      return;
    }
    if (!this.enabled) return;
    const exists = (await this.models().catch(() => [])).some((m) => m.model_name === name);
    if (!exists) await this.registerRoute(provider, model, params);
  }

  /** Remove every route belonging to a provider (all `<provider>/…` entries). */
  async deleteRoutesFor(provider: string): Promise<void> {
    if (this.config.litellmManaged) {
      await this.managed.deleteRoutesFor(`${provider}/`);
      return;
    }
    if (!this.enabled) return;
    try {
      const prefix = `${provider}/`;
      const ids = (await this.models())
        .filter((m) => m.model_name.startsWith(prefix))
        .map((m) => m.model_info?.id)
        .filter((id): id is string => Boolean(id));
      for (const id of ids) {
        await this.api('/model/delete', { method: 'POST', body: JSON.stringify({ id }) }).catch(() => undefined);
      }
      if (ids.length) this.logger.log(`Removed ${ids.length} LiteLLM route(s) for ${provider}`);
    } catch (e) {
      this.logger.warn(`deleteRoutesFor(${provider}) failed: ${(e as Error).message}`);
    }
  }

  private async deleteByName(name: string): Promise<void> {
    const ids = (await this.models().catch(() => []))
      .filter((m) => m.model_name === name)
      .map((m) => m.model_info?.id)
      .filter((id): id is string => Boolean(id));
    for (const id of ids) {
      await this.api('/model/delete', { method: 'POST', body: JSON.stringify({ id }) }).catch(() => undefined);
    }
  }
}

interface RawModel {
  model_name: string;
  litellm_params?: { model?: string; api_base?: string };
  model_info?: { id?: string; db_model?: boolean };
}

/**
 * Whether a provider needs LiteLLM to be usable by an agent: agents speak only
 * the Anthropic protocol, so OpenAI-native endpoints must be proxied. (DeepSeek
 * also serves Anthropic, so only api.openai.com is treated as needing a proxy.)
 */
export function isOpenAiNative(baseUrl: string | null | undefined): boolean {
  return /api\.openai\.com/i.test(baseUrl ?? '');
}
