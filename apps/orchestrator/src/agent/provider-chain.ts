import { parseEscalationStep, type Provider } from '@lds/shared';

/** The parts of an agent definition the chain depends on. */
export interface ChainAgent {
  provider?: string | null;
  model?: string | null;
  fallbackProviders?: string[] | null;
  /** The escalation ladder: `provider/model` steps, cheapest first (a stronger model for work a cheaper one could not finish). */
  escalation?: string[] | null;
}

export interface ChainEntry {
  provider: Provider;
  model: string;
  /** A step of the escalation ladder (quality escalation may move to it); the primary and the fallbacks are not. */
  rung?: boolean;
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
 * Order: the primary, then the escalation ladder (`escalation`, cheapest first), then the fallback providers — so a fallback is reached only
 * when every step of the ladder is unavailable. A ladder step names its own model; a step equal to an earlier one is dropped.
 *
 * `noFailover` (X-FO-1): a follow-up resumes a conversation that only its
 * provider holds — switching providers would hand the next one just the
 * follow-up text in an already-modified worktree. The chain is then the
 * primary alone; a provider failure ends the run with the error text instead.
 */
export async function resolveProviderChain(
  input: { agent: ChainAgent | null; defaultProvider: string; override?: string | null; /** a model forced on the primary (the model chosen for questions) */ primaryModel?: string | null; noFailover?: boolean; /** providers that just failed with a used-up quota / rate limit / bad credentials */ cooling?: (name: string) => boolean },
  lookup: (name: string) => Promise<Provider | null>,
  warn: (message: string) => void = () => undefined,
): Promise<ChainEntry[]> {
  const { agent, defaultProvider, override } = input;
  const primary = override?.trim() || agent?.provider || defaultProvider;
  const primaryName = primary?.trim();
  const steps = input.noFailover ? [] : (agent?.escalation ?? []).map((e) => parseEscalationStep(e)).filter((x): x is { provider: string; model: string } => x !== null);
  const names = input.noFailover ? [primary] : [primary, ...(agent?.fallbackProviders ?? [])];
  const seen = new Set<string>();
  const seenStep = new Set<string>();
  const chain: ChainEntry[] = [];
  const add = async (raw: string | null | undefined, wantModel?: string, rung?: boolean) => {
    const name = (raw ?? '').trim();
    if (!name) return;
    const key = `${name}|${wantModel ?? ''}`;
    if (rung ? seenStep.has(key) : seen.has(name) || chain.some((c) => c.provider.name === name)) return; // a fallback already on the ladder is not tried twice
    if (rung) seenStep.add(key);
    else seen.add(name);
    const provider = await lookup(name).catch(() => null);
    if (!provider) {
      warn(`Provider "${name}" not found — skipping in chain`);
      return;
    }
    const pinned = !override && name === primaryName && !rung ? agent?.model : undefined;
    const forced = !rung && name === primaryName ? input.primaryModel : undefined;
    const model = (wantModel || forced || pinned || provider.model || '').trim();
    if (!model) {
      warn(`Provider "${name}" has no model — skipping in chain`);
      return;
    }
    // a step that is the model already in the chain (the primary's) adds nothing
    if (rung && chain.some((c) => c.provider.name === name && c.model === model)) return;
    chain.push(rung ? { provider, model, rung: true } : { provider, model });
  };
  await add(primary);
  for (const st of steps) await add(st.provider, st.model, true);
  for (const raw of names.slice(1)) await add(raw);
  // A provider that just ran out of quota (or was refused) goes to the END of the chain: the run starts on a fallback instead of
  // failing first on the same provider. If every provider is cooling, the order stays as declared. A pinned override/follow-up
  // (a single provider) is never reordered.
  // (not with a ladder: its order is the point, and a step that fails just moves the run to the next one)
  if (input.cooling && chain.length > 1 && !override && !chain.some((c) => c.rung)) {
    const cool = chain.filter((c) => input.cooling!(c.provider.name));
    if (cool.length && cool.length < chain.length) return [...chain.filter((c) => !cool.includes(c)), ...cool];
  }
  return chain;
}
