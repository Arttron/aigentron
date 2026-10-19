import { describe, expect, it } from 'vitest';
import { ProviderCooldown } from './provider-cooldown';
import { classifyProviderFailure, isFailoverWorthy } from './run-outcome';
import { resolveProviderChain } from './provider-chain';

describe('quota / plan exhaustion is recognised as a failure worth failing over (real provider wordings)', () => {
  it.each([
    ['Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.', 'quota'],
    ['You exceeded your current quota, please check your plan and billing details. (insufficient_quota)', 'quota'],
    ['Claude AI usage limit reached|1765000000', 'quota'],
    ["You've hit your usage limit. Try again in 3 hours 12 minutes.", 'quota'],
    ['5-hour limit reached ∙ resets 7pm', 'quota'],
    ['402 Insufficient Balance', 'quota'],
    ['HTTP 402 Payment Required', 'quota'],
    ['Billing issue: your account is not active', 'quota'],
    ['Rate limit exceeded: too many requests (429)', 'rate'],
    ['The model is overloaded, try again later', 'rate'],
    ['Invalid API key provided', 'auth'],
    ['401 Unauthorized', 'auth'],
    ['SyntaxError: unexpected token in file.ts', 'other'],
    ['', 'other'],
  ])('%s → %s', (text, kind) => {
    expect(classifyProviderFailure(text)).toBe(kind);
    if (kind !== 'other') expect(isFailoverWorthy(text)).toBe(true);
  });

  it('an ordinary error text is not a failover reason', () => {
    expect(isFailoverWorthy('TypeError: cannot read properties of undefined')).toBe(false);
  });
});

describe('ProviderCooldown', () => {
  it('marks, expires and reports minutes left; a plain error does not cool', () => {
    let t = 0;
    const c = new ProviderCooldown(() => t);
    expect(c.mark('a', 'other')).toBe(0);
    expect(c.isCooling('a')).toBe(false);
    expect(c.mark('a', 'quota')).toBe(30 * 60_000);
    expect(c.isCooling('a')).toBe(true);
    expect(c.minutesLeft('a')).toBe(30);
    t += 29 * 60_000;
    expect(c.isCooling('a')).toBe(true);
    t += 2 * 60_000;
    expect(c.isCooling('a')).toBe(false);
    c.mark('b', 'rate');
    expect(c.minutesLeft('b')).toBe(2);
    c.clear('b');
    expect(c.isCooling('b')).toBe(false);
  });
});

describe('the chain starts on a fallback while the primary is cooling', () => {
  const prov = (name: string) => ({ name, model: `${name}-m` }) as never;
  const lookup = async (n: string) => prov(n);
  const agent = { provider: 'main', fallbackProviders: ['backup', 'third'] };
  const names = async (cooling: (n: string) => boolean, extra = {}) => (await resolveProviderChain({ agent, defaultProvider: 'main', cooling, ...extra }, lookup)).map((c) => c.provider.name);

  it('normal order when nothing cools', async () => {
    expect(await names(() => false)).toEqual(['main', 'backup', 'third']);
  });
  it('a cooling primary moves to the end', async () => {
    expect(await names((n) => n === 'main')).toEqual(['backup', 'third', 'main']);
  });
  it('several cooling providers keep their relative order at the end', async () => {
    expect(await names((n) => n === 'main' || n === 'backup')).toEqual(['third', 'main', 'backup']);
  });
  it('everything cooling: the declared order stays', async () => {
    expect(await names(() => true)).toEqual(['main', 'backup', 'third']);
  });
  it('an explicit per-task override or a follow-up (single provider) is never reordered', async () => {
    expect(await names((n) => n === 'main', { override: 'main' })).toEqual(['main', 'backup', 'third']);
    expect(await names((n) => n === 'main', { noFailover: true })).toEqual(['main']);
  });
});
