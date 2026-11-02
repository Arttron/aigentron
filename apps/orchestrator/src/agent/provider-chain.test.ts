import { describe, expect, it } from 'vitest';
import type { Provider } from '@lds/shared';
import { resolveProviderChain } from './provider-chain';

const providers: Record<string, Provider> = {
  a: { name: 'a', kind: 'anthropic', baseUrl: null, model: 'a-default', authMode: 'api-key', secret: 'k' } as Provider,
  b: { name: 'b', kind: 'openai', baseUrl: null, model: 'b-default', authMode: 'api-key', secret: 'k' } as Provider,
  nomodel: { name: 'nomodel', kind: 'openai', baseUrl: null, model: '', authMode: 'api-key', secret: 'k' } as Provider,
};
const lookup = async (name: string): Promise<Provider | null> => providers[name] ?? null;
const names = (chain: { provider: Provider; model: string }[]) => chain.map((c) => `${c.provider.name}:${c.model}`);

describe('resolveProviderChain (existing behaviour)', () => {
  it('uses the default provider when the agent has none', async () => {
    expect(names(await resolveProviderChain({ agent: null, defaultProvider: 'a' }, lookup))).toEqual(['a:a-default']);
  });
  it('primary then fallbacks, deduped, missing and model-less skipped', async () => {
    const warnings: string[] = [];
    const chain = await resolveProviderChain(
      { agent: { provider: 'a', fallbackProviders: ['a', 'ghost', 'nomodel', 'b'] }, defaultProvider: 'x' },
      lookup,
      (m) => warnings.push(m),
    );
    expect(names(chain)).toEqual(['a:a-default', 'b:b-default']);
    expect(warnings).toEqual(['Provider "ghost" not found — skipping in chain', 'Provider "nomodel" has no model — skipping in chain']);
  });
  it('pins the agent model on the primary only', async () => {
    const chain = await resolveProviderChain({ agent: { provider: 'a', model: 'a-pinned', fallbackProviders: ['b'] }, defaultProvider: 'x' }, lookup);
    expect(names(chain)).toEqual(['a:a-pinned', 'b:b-default']);
  });
  it('an override wins as primary and ignores the pin', async () => {
    const chain = await resolveProviderChain({ agent: { provider: 'a', model: 'a-pinned', fallbackProviders: ['a'] }, defaultProvider: 'x', override: ' b ' }, lookup);
    expect(names(chain)).toEqual(['b:b-default', 'a:a-default']);
  });
  it('an empty override falls back to the agent provider', async () => {
    expect(names(await resolveProviderChain({ agent: { provider: 'a' }, defaultProvider: 'b', override: '  ' }, lookup))).toEqual(['a:a-default']);
  });
  it('is empty when nothing resolves', async () => {
    expect(await resolveProviderChain({ agent: { provider: 'ghost' }, defaultProvider: 'ghost' }, lookup)).toEqual([]);
  });
});

describe('resolveProviderChain on a follow-up (X-FO-1)', () => {
  it('keeps only the primary — no silent switch of a resumed conversation', async () => {
    const chain = await resolveProviderChain({ agent: { provider: 'a', fallbackProviders: ['b'] }, defaultProvider: 'x', noFailover: true }, lookup);
    expect(names(chain)).toEqual(['a:a-default']);
  });
});

describe('resolveProviderChain with an escalation ladder', () => {
  const agent = { provider: 'a', model: 'a-cheap', escalation: ['a/a-strong', 'b/b-top'], fallbackProviders: ['b'] };
  it('primary, then the ladder steps (each with its own model), then the fallbacks', async () => {
    const chain = await resolveProviderChain({ agent, defaultProvider: 'x' }, lookup);
    expect(names(chain)).toEqual(['a:a-cheap', 'a:a-strong', 'b:b-top']); // the fallback b is already a step: not repeated
    expect(chain.map((c) => Boolean(c.rung))).toEqual([false, true, true]);
  });
  it('a fallback provider that is not a step comes last and is not a rung', async () => {
    const chain = await resolveProviderChain({ agent: { provider: 'a', escalation: ['a/a-strong'], fallbackProviders: ['b'] }, defaultProvider: 'x' }, lookup);
    expect(names(chain)).toEqual(['a:a-default', 'a:a-strong', 'b:b-default']);
    expect(chain.map((c) => Boolean(c.rung))).toEqual([false, true, false]);
  });
  it('skips a step whose provider is missing, malformed steps and a step equal to the primary', async () => {
    const warnings: string[] = [];
    const chain = await resolveProviderChain({ agent: { provider: 'a', model: 'm1', escalation: ['ghost/x', 'garbage', 'a/m1', 'a/m2'] }, defaultProvider: 'x' }, lookup, (m) => warnings.push(m));
    expect(names(chain)).toEqual(['a:m1', 'a:m2']);
    expect(warnings).toEqual(['Provider "ghost" not found — skipping in chain']);
  });
  it('a follow-up (noFailover) has the primary alone', async () => {
    expect(names(await resolveProviderChain({ agent, defaultProvider: 'x', noFailover: true }, lookup))).toEqual(['a:a-cheap']);
  });
  it('a cooling primary is not moved behind the ladder', async () => {
    const chain = await resolveProviderChain({ agent, defaultProvider: 'x', cooling: (n) => n === 'a' }, lookup);
    expect(names(chain)).toEqual(['a:a-cheap', 'a:a-strong', 'b:b-top']);
  });
});

describe('resolveProviderChain with a forced primary model (questions)', () => {
  it('the forced model wins over the pin on the primary and leaves the fallbacks alone', async () => {
    const chain = await resolveProviderChain({ agent: { provider: 'a', model: 'a-pinned', fallbackProviders: ['a'] }, defaultProvider: 'x', override: 'b', primaryModel: 'b-cheap' }, lookup);
    expect(names(chain)).toEqual(['b:b-cheap', 'a:a-default']);
  });
  it('without a forced model nothing changes', async () => {
    expect(names(await resolveProviderChain({ agent: { provider: 'a', model: 'a-pinned' }, defaultProvider: 'x', primaryModel: null }, lookup))).toEqual(['a:a-pinned']);
  });
});
