import type { Provider } from '@lds/shared';

/** The parts of an agent definition the chain depends on. */
export interface ChainAgent {
  provider?: string | null;
  model?: string | null;
  fallbackProviders?: string[] | null;
}

export interface ChainEntry {
  provider: Provider;
  model: string;
}

/**
 * Build the ordered provider chain for a run: the agent's provider (or the
 * default) first, then its declared fallbacks. Missing providers or ones
 * without a resolvable model are skipped; duplicates are collapsed.
 *
 * A per-task provider override (e.g. a channel's /model) wins as the primary.
 * The agent's pinned model belongs to its PRIMARY provider only — a fallback
 * provider can't run another provider's model, so it falls back to its own
 * default model. A provider override also ignores the pin (the pinned model is
 * for the agent's own provider, not the overridden one).
 *
 * `noFailover` (X-FO-1): a follow-up resumes a conversation that only its
 * provider holds — switching providers would hand the next one just the
 * follow-up text in an already-modified worktree. The chain is then the
 * primary alone; a provider failure ends the run with the error text instead.
 */
export async function resolveProviderChain(
  input: { agent: ChainAgent | null; defaultProvider: string; override?: string | null; noFailover?: boolean; /** providers that just failed with a used-up quota / rate limit / bad credentials */ cooling?: (name: string) => boolean },
  lookup: (name: string) => Promise<Provider | null>,
  warn: (message: string) => void = () => undefined,
): Promise<ChainEntry[]> {
  const { agent, defaultProvider, override } = input;
  const primary = override?.trim() || agent?.provider || defaultProvider;
  const primaryName = primary?.trim();
  const names = input.noFailover ? [primary] : [primary, ...(agent?.fallbackProviders ?? [])];
  const seen = new Set<string>();
  const chain: ChainEntry[] = [];
  for (const raw of names) {
    const name = (raw ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const provider = await lookup(name).catch(() => null);
    if (!provider) {
      warn(`Provider "${name}" not found — skipping in chain`);
      continue;
    }
    const pinned = !override && name === primaryName ? agent?.model : undefined;
    const model = (pinned || provider.model || '').trim();
    if (!model) {
      warn(`Provider "${name}" has no model — skipping in chain`);
      continue;
    }
    chain.push({ provider, model });
  }
  // A provider that just ran out of quota (or was refused) goes to the END of the chain: the run starts on a fallback instead of
  // failing first on the same provider. If every provider is cooling, the order stays as declared. A pinned override/follow-up
  // (a single provider) is never reordered.
  if (input.cooling && chain.length > 1 && !override) {
    const cool = chain.filter((c) => input.cooling!(c.provider.name));
    if (cool.length && cool.length < chain.length) return [...chain.filter((c) => !cool.includes(c)), ...cool];
  }
  return chain;
}
