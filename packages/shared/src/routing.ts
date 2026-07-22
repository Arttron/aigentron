/**
 * MODEL ROUTING — maps a {@link Provider} (an AI model endpoint) to the
 * Anthropic-compatible env vars an agent process receives. Agents reference a
 * provider by name; the orchestrator resolves it at spawn time and injects the
 * returned {@link AgentModelEnv} verbatim.
 */

/**
 * Exactly the Anthropic-compatible env vars an agent process should receive.
 * Only the keys relevant to the chosen provider are set.
 */
export interface AgentModelEnv {
  ANTHROPIC_MODEL: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
}

/**
 * An AI model endpoint an agent runs on. Agents reference a provider by name;
 * the orchestrator resolves it at spawn time into {@link AgentModelEnv}.
 */
export interface Provider {
  name: string;
  /** Upstream endpoint; null/empty = the family's native default. */
  baseUrl: string | null;
  model: string;
  authMode: 'api-key' | 'auth-token' | 'oauth-token';
  /** API key, auth token, or CLI-minted OAuth token, per authMode. */
  secret: string | null;
  /** Upstream family for LiteLLM routing: anthropic | openai | deepseek | ollama. */
  kind?: string;
  /** Optional per-provider rate caps enforced by LiteLLM (null = no cap). */
  rpm?: number | null;
  tpm?: number | null;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * CLI-minted OAuth/subscription token → the env var the corresponding agent
 * SDK/CLI reads it from, per upstream `kind`. The extension point for future
 * CLI-login providers (e.g. a different service's own login flow): add one
 * row here, no other branching needed.
 */
const OAUTH_ENV_VAR_BY_KIND: Partial<Record<string, keyof AgentModelEnv>> = {
  anthropic: 'CLAUDE_CODE_OAUTH_TOKEN',
};

/** Resolve a provider to the agent's Anthropic env. Throws if misconfigured. */
export function resolveProvider(provider: Provider): AgentModelEnv {
  if (!provider.model) throw new ProviderError(`provider "${provider.name}" has no model`);
  const env: AgentModelEnv = { ANTHROPIC_MODEL: provider.model };
  if (provider.authMode === 'oauth-token') {
    // CLI-minted subscription token (e.g. `claude setup-token`): always talks
    // to the family's native endpoint — baseUrl (meant for LiteLLM/proxy
    // routing) does not apply and is intentionally ignored here.
    const envVar = OAUTH_ENV_VAR_BY_KIND[provider.kind ?? 'anthropic'];
    if (!envVar) {
      throw new ProviderError(`provider "${provider.name}" has no oauth-token support for kind "${provider.kind}"`);
    }
    if (!provider.secret) throw new ProviderError(`provider "${provider.name}" requires an OAuth token`);
    env[envVar] = provider.secret;
    return env;
  }
  if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl;
  if (provider.authMode === 'api-key') {
    if (!provider.secret) throw new ProviderError(`provider "${provider.name}" requires an API key`);
    env.ANTHROPIC_API_KEY = provider.secret;
  } else {
    // auth-token: local / Anthropic-compatible endpoints (token may be ignored).
    env.ANTHROPIC_AUTH_TOKEN = provider.secret || 'local';
  }
  return env;
}
