import { describe, expect, it } from 'vitest';
import { compareModelCost, describeModel, lookupPrice, formatEscalationStep, modelTierByName, modelTierByPrice, parseEscalationStep, type ModelInfo } from './model-tier';

describe('model tiers', () => {
  it('guesses a tier from the name', () => {
    for (const m of ['claude-haiku-4-5-20251001', 'gpt-4o-mini', 'gemini-2.5-flash', 'gemma4:latest', 'llama3.1:8b']) expect(modelTierByName(m), m).toBe('cheap');
    for (const m of ['claude-sonnet-5-5', 'gpt-4o', 'gpt-4.1', 'gemini-2.5-pro-x']) expect(['mid', 'top'], m).toContain(modelTierByName(m));
    for (const m of ['claude-opus-5-5', 'o3', 'gpt-5', 'llama3.1:70b']) expect(modelTierByName(m), m).toBe('top');
    expect(modelTierByName('some-unknown-model')).toBe('mid');
    expect(modelTierByName('gpt-5-mini')).toBe('cheap');
  });
  it('a tier from a price', () => {
    expect([0.1, 1, 1.5, 3, 4.4, 5, 15].map(modelTierByPrice)).toEqual(['cheap', 'cheap', 'cheap', 'mid', 'mid', 'top', 'top']);
  });
  it('sorts cheapest first by tier, then price, then name', () => {
    const m = (id: string, tier: ModelInfo['tier'], inputPerM?: number): ModelInfo => ({ id, tier, inputPerM, source: 'name' });
    const sorted = [m('b-top', 'top'), m('z-cheap', 'cheap', 0.5), m('a-cheap', 'cheap', 0.2), m('mid', 'mid')].sort(compareModelCost).map((x) => x.id);
    expect(sorted).toEqual(['a-cheap', 'z-cheap', 'mid', 'b-top']);
  });
  it('parses a ladder step: provider, then everything after the first slash', () => {
    expect(parseEscalationStep('claude-sub/claude-opus-5-5')).toEqual({ provider: 'claude-sub', model: 'claude-opus-5-5' });
    expect(parseEscalationStep('litellm/openai/gpt-4o')).toEqual({ provider: 'litellm', model: 'openai/gpt-4o' });
    expect(parseEscalationStep('ollama-local/gemma4:latest')).toEqual({ provider: 'ollama-local', model: 'gemma4:latest' });
    for (const bad of ['', 'noslash', '/model', 'prov/']) expect(parseEscalationStep(bad), bad).toBeNull();
    expect(formatEscalationStep('p', 'm/x')).toBe('p/m/x');
  });
});

describe('prices', () => {
  const prices = { 'gpt-4o-mini': { input: 1.5e-7, output: 6e-7 }, 'claude-opus-4-5': { input: 5e-6, output: 2.5e-5 }, 'anthropic/claude-x': { input: 2e-6, output: 1e-5 } };
  it('finds a price by id, bare name, provider prefix or without a date', () => {
    expect(lookupPrice(prices, 'gpt-4o-mini')?.input).toBe(1.5e-7);
    expect(lookupPrice(prices, 'openai/gpt-4o-mini')?.input).toBe(1.5e-7);
    expect(lookupPrice(prices, 'claude-opus-4-5-20251101')?.input).toBe(5e-6);
    expect(lookupPrice(prices, 'claude-x')?.input).toBe(2e-6);
    expect(lookupPrice(prices, 'nothing')).toBeNull();
  });
  it('describes a model: price → tier, local → free, otherwise the name', () => {
    expect(describeModel('gpt-4o-mini', { prices })).toMatchObject({ source: 'price', tier: 'cheap', inputPerM: 0.15, outputPerM: 0.6 });
    expect(describeModel('claude-opus-4-5', { prices })).toMatchObject({ source: 'price', tier: 'top', inputPerM: 5 });
    expect(describeModel('gemma4:latest', { local: true })).toMatchObject({ source: 'local', inputPerM: 0, tier: 'cheap' });
    expect(describeModel('claude-haiku-4-5', {})).toMatchObject({ source: 'name', tier: 'cheap' });
  });
});
