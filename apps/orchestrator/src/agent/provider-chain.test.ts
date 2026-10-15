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
