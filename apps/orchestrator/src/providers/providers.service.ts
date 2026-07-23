import { Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { resolveProvider, type AgentModelEnv, type Provider } from '@lds/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { LitellmService, defaultKind, stripSelfPrefix } from '../litellm/litellm.service';

type ProviderRow = NonNullable<Awaited<ReturnType<PrismaService['provider']['findUnique']>>>;

export interface ProviderPatch {
  kind?: string;
  baseUrl?: string | null;
  model?: string;
  authMode?: 'api-key' | 'auth-token' | 'oauth-token';
  secret?: string | null;
  rpm?: number | null;
  tpm?: number | null;
}

/**
 * Registry of AI model endpoints (providers). Seeded from environment on first
 * use; agents reference a provider by name and the executor resolves it to the
 * Anthropic env at spawn time. OpenAI-native providers are mirrored into the
 * LiteLLM proxy so agents (Anthropic-only) can use them.
 */
@Injectable()
export class ProvidersService implements OnModuleInit {
  private readonly logger = new Logger(ProvidersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly litellm: LitellmService,
  ) {}


  /** Re-sync LiteLLM routes on boot (idempotent; covers a litellm DB reset). */
  async onModuleInit(): Promise<void> {
    if (!this.litellm.enabled) return;
    try {
      // On a genuinely fresh DB (no rows yet — e.g. first boot of a new
      // volume) the table is only seeded lazily on the first `list()`/`get()`
      // call, which nothing has made yet at this point in boot; without this,
      // litellm stays routeless until someone happens to hit GET /providers
      // or edit one.
      await this.ensureSeeded();
      const rows = await this.prisma.provider.findMany();
      await Promise.all(rows.map((r) => this.syncRoute(r)));
    } catch (e) {
      this.logger.warn(`LiteLLM route resync failed: ${(e as Error).message}`);
    }
  }

  /**
   * Keep a provider's LiteLLM route in step with its record. EVERY provider is
   * proxied through litellm now, so each gets a `<name>/<model>` route for its
   * default model (the executor lazily adds routes for other models an agent
   * picks). Never throws — a litellm hiccup must not fail provider CRUD.
   */
  private async syncRoute(row: ProviderRow): Promise<void> {
    if (!this.litellm.enabled) return;
    try {
      await this.litellm.deleteRoutesFor(row.name);
      // Gateway-verbatim provider: nothing to register (see servesVerbatim).
      if (this.litellm.servesVerbatim(row)) return;
      // Cloud kinds need a key; ollama/local may not. Skip if no model yet.
      if (row.model && (row.secret || row.kind === 'ollama')) {
        await this.litellm.registerRoute(row.name, row.model, {
          kind: row.kind,
          apiBase: row.baseUrl,
          apiKey: row.secret ?? '',
          rpm: row.rpm,
          tpm: row.tpm,
        });
      }
    } catch (e) {
      this.logger.warn(`LiteLLM route sync for "${row.name}" failed: ${(e as Error).message}`);
    }
  }

  /**
   * Create the default providers from env if the table is empty. The
   * preceding count check is what makes this safe without `skipDuplicates` —
   * unsupported on SQLite (Prisma error: "Unknown argument `skipDuplicates`"),
   * so it's dropped here rather than only for one storage driver.
   */
  private async ensureSeeded(): Promise<void> {
    if ((await this.prisma.provider.count()) > 0) return;
    const key = cleanKey(process.env.ANTHROPIC_API_KEY);
    await this.prisma.provider.createMany({
      data: [
        {
          name: 'ollama-local',
          kind: 'ollama',
          // OLLAMA_BASE_URL (full profile's .env.example) and
          // OLLAMA_NATIVE_URL (minimal/bare-metal's .env.minimal.example,
          // also read by AppConfigService for the model picker) are two
          // names for the same thing across profiles — this shared,
          // profile-agnostic seed path needs to check both, or minimal/
          // bare-metal installs always silently got the Docker-only
          // fallback regardless of what they'd actually configured.
          baseUrl: process.env.OLLAMA_BASE_URL || process.env.OLLAMA_NATIVE_URL || 'http://host.docker.internal:11434',
          // A real Ollama tag (kind=ollama wraps it to `ollama_chat/<tag>`); a
          // litellm alias like `local-coder` would 404 (no such Ollama tag).
          model: process.env.ROUTINE_MODEL || 'qwen3-coder:30b',
          authMode: 'auth-token',
          secret: process.env.OLLAMA_AUTH_TOKEN || 'ollama',
        },
        {
          name: 'claude-cloud',
          kind: 'anthropic',
          baseUrl: null,
          model: process.env.COMPLEX_MODEL || 'claude-sonnet-4-6',
          authMode: 'api-key',
          secret: key,
        },
      ],
    });
    this.logger.log('Seeded default providers (ollama-local, claude-cloud)');
  }

  async list(): Promise<ProviderRow[]> {
    await this.ensureSeeded();
    return this.prisma.provider.findMany({ orderBy: { name: 'asc' } });
  }

  async getRow(name: string): Promise<ProviderRow> {
    const row = await this.prisma.provider.findUnique({ where: { name } });
    if (!row) throw new NotFoundException(`Provider not found: ${name}`);
    return row;
  }

  /** Shared Provider shape for resolveProvider. */
  async get(name: string): Promise<Provider> {
    return toProvider(await this.getRow(name));
  }

  /** Resolve a provider name to the agent's Anthropic env. */
  async resolveEnv(name: string): Promise<AgentModelEnv> {
    return resolveProvider(await this.get(name));
  }

  async create(input: { name: string } & ProviderPatch): Promise<ProviderRow> {
    const row = await this.prisma.provider.create({
      data: {
        name: input.name,
        kind: input.kind ?? defaultKind(input.baseUrl),
        baseUrl: input.baseUrl ?? null,
        model: input.model ? stripSelfPrefix(input.name, input.model) : '',
        authMode: input.authMode ?? 'auth-token',
        secret: input.secret ?? null,
        rpm: input.rpm ?? null,
        tpm: input.tpm ?? null,
      },
    });
    await this.syncRoute(row);
    return row;
  }

  async update(name: string, patch: ProviderPatch): Promise<ProviderRow> {
    await this.getRow(name);
    const data = patch.model ? { ...patch, model: stripSelfPrefix(name, patch.model) } : patch;
    const row = await this.prisma.provider.update({ where: { name }, data });
    await this.syncRoute(row);
    return row;
  }

  async remove(name: string): Promise<void> {
    await this.getRow(name);
    await this.prisma.provider.delete({ where: { name } });
    await this.litellm.deleteRoutesFor(name).catch(() => undefined);
  }

  /**
   * Connectivity check ("whoami"): send a tiny generation request in the
   * provider's native protocol and report whether it succeeded, the model the
   * endpoint reports, and what it replied. Never throws — returns the failure
   * in the result.
   *
   * Anthropic and OpenAI use incompatible request/response shapes, so we
   * dispatch by API kind (inferred from the base URL): OpenAI/DeepSeek speak
   * `/chat/completions` with a Bearer key; Anthropic (and local/proxy endpoints
   * the agent SDK talks to) speak `/v1/messages` with x-api-key/anthropic-version.
   */
  async test(name: string): Promise<ProviderTestResult> {
    const p = toProvider(await this.getRow(name));
    if (!p.model) return { ok: false, error: `provider "${name}" has no model` };
    if (p.authMode === 'oauth-token') {
      // The Claude Agent SDK handles this token's auth internally; we don't
      // know its exact request shape, so don't guess at an HTTP probe — an
      // agent run is the real test.
      return { ok: false, error: 'OAuth/subscription tokens aren’t verified via HTTP probe — start a task on this provider to confirm it works.' };
    }

    const kind = p.kind || defaultKind(p.baseUrl);
    const anthropic = kind === 'anthropic';
    const auth = authHeaders(kind, p);
    if (auth.error) return { ok: false, error: auth.error };
    const url = anthropic ? `${anthropicBase(p.baseUrl)}/v1/messages` : `${oaiBase(kind, p.baseUrl)}/chat/completions`;

    const baseBody: Record<string, unknown> = {
      model: p.model,
      messages: [{ role: 'user', content: 'Reply with ONLY your exact model name/identifier — no other text.' }],
    };
    const send = async (tokenParam: 'max_tokens' | 'max_completion_tokens') => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const startedAt = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: auth.headers,
          body: JSON.stringify({ ...baseBody, [tokenParam]: 64 }),
          signal: controller.signal,
        });
        return { res, text: await res.text(), latencyMs: Date.now() - startedAt };
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      let { res, text, latencyMs } = await send('max_tokens');
      // Newer OpenAI (reasoning) models reject max_tokens — retry the param they want.
      if (!res.ok && !anthropic && res.status === 400 && /max_completion_tokens/i.test(text)) {
        ({ res, text, latencyMs } = await send('max_completion_tokens'));
      }
      if (!res.ok) {
        return { ok: false, status: res.status, latencyMs, error: extractError(text) || `HTTP ${res.status}` };
      }
      let reply = '';
      let model = p.model;
      try {
        const json = JSON.parse(text);
        model = json.model || model;
        reply = (anthropic ? anthropicText(json) : openAiText(json)).trim();
      } catch {
        /* a 200 that isn't JSON — connectivity is fine, leave reply empty */
      }
      // Connectivity is fine — now probe structured tool-use (agents need it).
      const probe = await this.probeToolUse(anthropic, url, auth.headers, p.model);
      return { ok: true, latencyMs, model, reply: reply.slice(0, 200), ...probe };
    } catch (e) {
      const err = e as Error;
      return { ok: false, error: err.name === 'AbortError' ? 'timed out after 30s' : err.message };
    }
  }

  /**
   * Ask the endpoint to call a trivial tool (forcing the choice). A tool-capable
   * model returns a structured tool call; a weak/local one returns plain text
   * (which breaks the agent SDK). Best-effort: never throws — inconclusive → undefined.
   */
  private async probeToolUse(
    anthropic: boolean,
    url: string,
    headers: Record<string, string>,
    model: string,
  ): Promise<{ toolUse?: boolean; toolUseNote?: string }> {
    const params = { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] };
    const messages = [{ role: 'user', content: 'Use the echo tool with word "ping".' }];
    const tools = anthropic
      ? [{ name: 'echo', description: 'Echo the given word back.', input_schema: params }]
      : [{ type: 'function', function: { name: 'echo', description: 'Echo the given word back.', parameters: params } }];
    const forced = anthropic
      ? { type: 'tool', name: 'echo' }
      : { type: 'function', function: { name: 'echo' } };
    const auto = anthropic ? { type: 'auto' } : 'auto';
    const body: Record<string, unknown> = { model, max_tokens: 256, tools, messages };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const post = (extra?: Record<string, unknown>) =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, tool_choice: forced, ...extra }),
        signal: controller.signal,
      });
    try {
      let res = await post();
      let text = await res.text();
      // Reasoning OpenAI models want max_completion_tokens instead of max_tokens.
      if (!res.ok && !anthropic && res.status === 400 && /max_completion_tokens/i.test(text)) {
        res = await post({ max_tokens: undefined, max_completion_tokens: 256 });
        text = await res.text();
      }
      // Some models reject a FORCED tool_choice (e.g. thinking mode) — a capable
      // model will still call the tool when merely offered it.
      if (!res.ok && /tool_choice/i.test(text)) {
        res = await post({ tool_choice: auto });
        text = await res.text();
      }
      if (!res.ok) {
        return { toolUseNote: `tool-use probe: ${extractError(text) || `HTTP ${res.status}`}` };
      }
      const json = JSON.parse(text);
      const called = anthropic
        ? Array.isArray(json?.content) && json.content.some((b: { type?: string }) => b?.type === 'tool_use')
        : Array.isArray(json?.choices?.[0]?.message?.tool_calls) &&
          json.choices[0].message.tool_calls.length > 0;
      return called
        ? { toolUse: true }
        : { toolUse: false, toolUseNote: 'model replied with text instead of a tool call' };
    } catch (e) {
      const err = e as Error;
      return { toolUseNote: `tool-use probe: ${err.name === 'AbortError' ? 'timed out' : err.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Models the provider's endpoint advertises (for the agent's model picker). */
  async listModels(name: string): Promise<ProviderModelsResult> {
    const p = toProvider(await this.getRow(name));
    if (p.authMode === 'oauth-token') {
      // Same reasoning as test(): don't guess at the OAuth token's request shape.
      return { ok: false, models: [], error: 'model listing isn’t available for oauth-token providers — type the model name directly.' };
    }
    return this.fetchModels({ kind: p.kind || defaultKind(p.baseUrl), baseUrl: p.baseUrl, authMode: p.authMode, secret: p.secret });
  }

  /** Same as listModels but for unsaved params — lets the form preview models. */
  async previewModels(input: {
    kind?: string;
    baseUrl?: string | null;
    authMode?: 'api-key' | 'auth-token' | 'oauth-token';
    secret?: string | null;
  }): Promise<ProviderModelsResult> {
    if (input.authMode === 'oauth-token') {
      return { ok: false, models: [], error: 'model listing isn’t available for oauth-token providers — type the model name directly.' };
    }
    return this.fetchModels({
      kind: input.kind || defaultKind(input.baseUrl),
      baseUrl: input.baseUrl || null,
      authMode: input.authMode === 'api-key' ? 'api-key' : 'auth-token',
      secret: input.secret || null,
    });
  }

  private async fetchModels(p: {
    kind: string;
    baseUrl: string | null;
    authMode: 'api-key' | 'auth-token';
    secret: string | null;
  }): Promise<ProviderModelsResult> {
    // Ollama models come from the real Ollama host (its `ollama list`) — never
    // litellm (which only knows configured routes) nor the litellm-gateway
    // baseUrl. ollamaEndpoint resolves the native host.
    const baseUrl = p.kind === 'ollama' ? this.litellm.ollamaEndpoint(p.baseUrl) : p.baseUrl;
    // A gateway-verbatim provider serves litellm model_names — list those
    // (needs the master key), not an upstream /models.
    if (this.litellm.servesVerbatim(p)) {
      return { ok: true, models: await this.litellm.listModelNames() };
    }
    const anthropic = p.kind === 'anthropic';
    const auth = authHeaders(p.kind, p);
    if (auth.error) return { ok: false, models: [], error: auth.error };
    const url = anthropic ? `${anthropicBase(baseUrl)}/v1/models` : `${oaiBase(p.kind, baseUrl)}/models`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { headers: auth.headers, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        // A 404 on a model-LISTING route (unlike other statuses) usually means
        // the upstream just doesn't implement this endpoint at all, rather than
        // anything wrong with the request — common for third-party
        // Anthropic-protocol-compatible layers (e.g. DeepSeek's /anthropic),
        // which often only implement the messages endpoint. Confirmed live:
        // the same secret/URL that works fine for actual chat/tool-use calls
        // still 404s here.
        //
        // Some of these vendors (DeepSeek confirmed) DO support listing on
        // their own native OpenAI-compatible root — same base with the
        // compat suffix stripped, same secret, just Bearer auth instead of
        // x-api-key. Try that before giving up; only if it also fails do we
        // show the "doesn't support listing" message instead of a raw status.
        if (res.status === 404 && anthropic && baseUrl) {
          const nativeBase = baseUrl.replace(/\/anthropic\/?$/, '');
          if (nativeBase !== baseUrl) {
            const fallback = await this.tryFetchModelNames(
              `${nativeBase}/v1/models`,
              { 'content-type': 'application/json', authorization: `Bearer ${p.secret ?? ''}` },
              controller.signal,
            );
            if (fallback) return { ok: true, models: fallback };
          }
        }
        const error =
          res.status === 404
            ? 'this endpoint doesn’t support listing models — type the model name manually'
            : extractError(text) || `HTTP ${res.status}`;
        return { ok: false, models: [], error };
      }
      const json = JSON.parse(text);
      const rows: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      const models = rows
        .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
      return { ok: true, models: Array.from(new Set(models)).sort() };
    } catch (e) {
      const err = e as Error;
      return { ok: false, models: [], error: err.name === 'AbortError' ? 'timed out after 15s' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Best-effort model-name fetch for the anthropic-compat 404 fallback above
   *  — null on any failure (network error, non-2xx, empty list), never throws. */
  private async tryFetchModelNames(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<string[] | null> {
    try {
      const res = await fetch(url, { headers, signal });
      const text = await res.text();
      if (!res.ok) return null;
      const json = JSON.parse(text);
      const rows: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      const models = rows
        .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
      return models.length ? Array.from(new Set(models)).sort() : null;
    } catch {
      return null;
    }
  }
}

/** Base URL for an Anthropic-protocol upstream. */
function anthropicBase(baseUrl: string | null): string {
  return (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
}

/** Base for an OpenAI-style upstream (Ollama exposes it under /v1). */
function oaiBase(kind: string, baseUrl: string | null): string {
  const base = (baseUrl || '').replace(/\/$/, '');
  return kind === 'ollama' ? `${base}/v1` : base;
}

/** Build auth headers for a direct upstream test/model-list, by kind. */
function authHeaders(
  kind: string,
  p: { authMode: 'api-key' | 'auth-token' | 'oauth-token'; secret: string | null },
): {
  headers: Record<string, string>;
  error?: string;
} {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (kind === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (p.authMode === 'api-key') {
      if (!p.secret) return { headers, error: 'an API key is required' };
      headers['x-api-key'] = p.secret;
    } else {
      headers['authorization'] = `Bearer ${p.secret || 'local'}`;
    }
    return { headers };
  }
  // openai / deepseek / ollama — Bearer; only local (ollama) may omit the key.
  if (kind !== 'ollama' && !p.secret) return { headers, error: 'an API key is required' };
  if (p.secret) headers['authorization'] = `Bearer ${p.secret}`;
  return { headers };
}

/** Extract assistant text from an Anthropic messages response. */
function anthropicText(json: { content?: Array<{ type: string; text?: string }> }): string {
  return (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** Extract assistant text from an OpenAI chat-completions response. */
function openAiText(json: { choices?: Array<{ message?: { content?: string } }> }): string {
  return json.choices?.[0]?.message?.content ?? '';
}

/** Pull a human-readable message out of an error body (JSON {error:{message}} or raw). */
function extractError(text: string): string {
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message ?? json?.error ?? json?.message;
    if (typeof msg === 'string') return msg.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}

/** Result of a provider connectivity test. */
export interface ProviderTestResult {
  ok: boolean;
  /** Model the endpoint reported (often echoes the request, but not always). */
  model?: string;
  /** The model's reply text (truncated). */
  reply?: string;
  latencyMs?: number;
  status?: number;
  error?: string;
  /**
   * Structured tool-use support: true if the model emitted a real tool call when
   * asked, false if it replied with text instead (won't drive the agent SDK),
   * undefined if the probe couldn't run. Agents need `true` to be usable.
   */
  toolUse?: boolean;
  toolUseNote?: string;
}

/** Result of listing a provider's advertised models. */
export interface ProviderModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
}

const KNOWN_AUTH_MODES = ['api-key', 'auth-token', 'oauth-token'] as const;

function toProvider(row: ProviderRow): Provider {
  return {
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    model: row.model,
    authMode: (KNOWN_AUTH_MODES as readonly string[]).includes(row.authMode)
      ? (row.authMode as Provider['authMode'])
      : 'auth-token',
    secret: row.secret,
    rpm: row.rpm,
    tpm: row.tpm,
  };
}

function cleanKey(key?: string): string | null {
  if (!key || key.startsWith('sk-ant-xxx')) return null;
  return key;
}
