// How models are ranked by cost when a person picks them (an agent's escalation ladder): a tier guessed from the name, refined by a price when
// the gateway knows it. Names are a hint, not a fact: every value can be overridden by hand.

export type ModelTier = 'cheap' | 'mid' | 'top';

/** What is known about one model: where its rank came from. */
export interface ModelInfo {
  id: string;
  tier: ModelTier;
  /** USD per million tokens, when the gateway (LiteLLM's price map) knows them. */
  inputPerM?: number;
  outputPerM?: number;
  /** `price` = from the gateway's price map, `local` = runs on this machine, `name` = guessed from the model's name. */
  source: 'price' | 'local' | 'name';
}

const CHEAP = /haiku|(?<![a-z])mini(?![a-z])|nano|flash|(?<![a-z])lite(?![a-z])|small|tiny|instant|gemma|(?<![a-z])phi/i;
const TOP = /opus|(?<![a-z0-9])o[134](?:-|$)|gpt-5(?!.*(mini|nano))|ultra|[-/]pro(?![a-z])|large|405b/i;
const MID = /sonnet|gpt-4o|gpt-4\.1|gpt-4-turbo|gemini|mistral-medium|deepseek|command-r/i;

/** A tier from a model's name; `mid` when the name says nothing. */
export function modelTierByName(id: string): ModelTier {
  const s = id.toLowerCase();
  // a local model's size says how capable it is: up to 14B small, 60B and more big
  const size = /[:\-_](\d{1,3}(?:\.\d)?)b\b/.exec(s);
  if (size) {
    const n = Number(size[1]);
    return n <= 14 ? 'cheap' : n >= 60 ? 'top' : 'mid';
  }
  if (CHEAP.test(s) && !/opus/.test(s)) return 'cheap';
  if (TOP.test(s)) return 'top';
  if (MID.test(s)) return 'mid';
  return 'mid';
}

/** The tier from a price (USD per million INPUT tokens): cheap up to 1.5, mid under 4.5, else top. */
export function modelTierByPrice(inputPerM: number): ModelTier {
  return inputPerM <= 1.5 ? 'cheap' : inputPerM < 4.5 ? 'mid' : 'top';
}

const TIER_ORDER: Record<ModelTier, number> = { cheap: 0, mid: 1, top: 2 };

/** Cheapest first: by tier, then by known price, then by name. */
export function compareModelCost(a: ModelInfo, b: ModelInfo): number {
  return TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || (a.inputPerM ?? Infinity) - (b.inputPerM ?? Infinity) || a.id.localeCompare(b.id);
}

/**
 * One rung of an agent's escalation ladder is written `provider/model` (the provider's name, then the model — which may itself contain `/` or `:`).
 * Returns null for anything that is not that shape.
 */
export function parseEscalationStep(entry: string): { provider: string; model: string } | null {
  const i = entry.indexOf('/');
  if (i <= 0) return null;
  const provider = entry.slice(0, i).trim();
  const model = entry.slice(i + 1).trim();
  return provider && model ? { provider, model } : null;
}

export const formatEscalationStep = (provider: string, model: string): string => `${provider}/${model}`;

/** USD per token, as LiteLLM's price map holds them. */
export type PriceMap = Record<string, { input: number; output: number }>;

/** A model's price from the map: its own id, then with a provider prefix (`openai/…`), then without a `-YYYYMMDD` date or a `-latest` suffix. */
export function lookupPrice(map: PriceMap, id: string): { input: number; output: number } | null {
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  for (const k of [id, bare, `anthropic/${bare}`, `openai/${bare}`, `gemini/${bare}`, bare.replace(/-\d{8}$/, ''), bare.replace(/-latest$/, '')]) {
    const hit = map[k];
    if (hit) return hit;
  }
  return null;
}

/** What is known about a model: its price when the map has one, `local` for a model on this machine (free), else a tier guessed from the name. */
export function describeModel(id: string, opts: { prices?: PriceMap; local?: boolean } = {}): ModelInfo {
  if (opts.local) return { id, tier: modelTierByName(id), inputPerM: 0, outputPerM: 0, source: 'local' };
  const p = opts.prices ? lookupPrice(opts.prices, id) : null;
  if (p && p.input > 0) {
    const inputPerM = Math.round(p.input * 1e6 * 1000) / 1000;
    const outputPerM = Math.round(p.output * 1e6 * 1000) / 1000;
    // the price decides the tier — except that a name that plainly says "top" (opus, o3) stays top even when its price has fallen
    const byName = modelTierByName(id);
    return { id, tier: byName === 'top' ? 'top' : modelTierByPrice(inputPerM), inputPerM, outputPerM, source: 'price' };
  }
  return { id, tier: modelTierByName(id), source: 'name' };
}
