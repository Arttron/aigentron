import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatOnce = vi.hoisted(() => vi.fn());
vi.mock('./simple-chat', () => ({ chatOnce }));
vi.mock('../provider-login/claude-probe', () => ({ askClaudeCli: vi.fn() }));

import { TitlesService } from './titles.service';

/** A task's title is made by a small model: when the first provider is down, the next one must answer. */
function make(providers: string[], defaultProvider = providers[0] ?? '') {
  const config = { secretsDir: mkdtempSync(join(tmpdir(), 'titles-')) };
  const prov = {
    list: async () => providers.map((name) => ({ name })),
    get: async (name: string) => ({ name, kind: 'openai', authMode: 'auth-token' }),
    chatEndpoint: async (name: string) => ({ url: `http://${name}/chat`, headers: {}, model: `${name}-model` }),
  };
  const settings = { defaultProvider: async () => defaultProvider };
  return new TitlesService(config as never, prov as never, settings as never);
}
const answers = (by: Record<string, string | Error>): void => {
  chatOnce.mockImplementation(async (ep: { url: string }) => {
    const name = ep.url.replace('http://', '').replace('/chat', '');
    const r = by[name];
    if (r instanceof Error) throw r;
    return r ?? 'Fallback title';
  });
};

describe('TitlesService: providers that fail', () => {
  beforeEach(() => {
    chatOnce.mockReset();
  });

  it('a default provider that is down is skipped: the next one names the task', async () => {
    answers({ local: new Error('Cannot connect to host.docker.internal:11434'), gpt: 'Fix the mobile menu overlap' });
    const svc = make(['local', 'gpt', 'deepseek']);
    expect(await svc.suggest({ prompt: 'Why does the mobile menu overlap the logo on small screens, and how do we fix it?' })).toBe('Fix the mobile menu overlap');
    expect(chatOnce).toHaveBeenCalledTimes(2);
  });

  it('a provider that failed is left alone for a while (no waiting for the dead one on every task)', async () => {
    answers({ local: new Error('down'), gpt: 'A clear title' });
    const svc = make(['local', 'gpt']);
    await svc.suggest({ prompt: 'a first long enough request to be worth naming properly' });
    chatOnce.mockClear();
    expect(await svc.suggest({ prompt: 'a second long enough request to be worth naming properly' })).toBe('A clear title');
    expect(chatOnce).toHaveBeenCalledTimes(1); // gpt only
  });

  it('when every provider fails there is no title (the first line stays), and Try it says why', async () => {
    answers({ a: new Error('401 invalid key'), b: new Error('rate limited') });
    const svc = make(['a', 'b']);
    expect(await svc.suggest({ prompt: 'a long enough request to be worth naming' })).toBeNull();
    const t = await svc.test('a long enough request to be worth naming');
    expect(t.ok).toBe(false);
    expect(t.error).toContain('rate limited'); // the last error
  });

  it('a chosen provider is the only one tried', async () => {
    answers({ local: 'Never asked', gpt: new Error('down') });
    const svc = make(['local', 'gpt']);
    svc.save({ enabled: true, provider: 'gpt', model: '' });
    expect(await svc.suggest({ prompt: 'a long enough request to be worth naming' })).toBeNull();
    expect(chatOnce).toHaveBeenCalledTimes(1);
  });

  it('translation falls back the same way', async () => {
    answers({ local: new Error('down'), gpt: 'Привет' });
    const svc = make(['local', 'gpt']);
    expect(await svc.translate('Hello', 'ru')).toEqual({ ok: true, text: 'Привет' });
  });

  it('an empty reply (a model that only thought) or no usable title counts as a miss: the next provider is asked', async () => {
    answers({ thinker: '', chatty: '   ', gpt: 'Fix the mobile menu overlap' });
    const svc = make(['thinker', 'chatty', 'gpt']);
    expect(await svc.suggest({ prompt: 'Why does the mobile menu overlap the logo on small screens?' })).toBe('Fix the mobile menu overlap');
    expect(chatOnce).toHaveBeenCalledTimes(3);
  });

  it('a healthy provider that gave an unusable reply is not put aside (only the ones that failed are)', async () => {
    answers({ chatty: '   ', gpt: 'A clear title' });
    const svc = make(['chatty', 'gpt']);
    await svc.suggest({ prompt: 'a long enough request to be worth naming properly, first' });
    chatOnce.mockClear();
    await svc.suggest({ prompt: 'a long enough request to be worth naming properly, second' });
    expect(chatOnce.mock.calls.length).toBe(2); // chatty is asked again; it was not in the cooldown
  });

  it('the whole question has one time budget: a slow provider does not leave the rest waiting for ever', async () => {
    const times: number[] = [];
    chatOnce.mockImplementation(async (_ep: unknown, o: { timeoutMs: number }) => {
      times.push(o.timeoutMs);
      throw new Error('timeout');
    });
    const svc = make(['a', 'b', 'c', 'd']);
    await svc.suggest({ prompt: 'a long enough request to be worth naming properly' });
    expect(times.length).toBeGreaterThan(0);
    expect(Math.max(...times)).toBeLessThanOrEqual(12_000); // each attempt is bounded by the per-attempt cap
  });
});

