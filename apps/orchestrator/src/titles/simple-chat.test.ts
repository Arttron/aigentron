import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatOnce, type ChatEndpoint } from './simple-chat';

const openai: ChatEndpoint = { style: 'openai', url: 'http://x/chat', headers: {}, model: 'm' };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('chatOnce', () => {
  it('returns the reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ choices: [{ message: { content: ' A title ' }, finish_reason: 'stop' }] })));
    expect(await chatOnce(openai, { system: 's', user: 'u' })).toBe('A title');
  });

  it('a reasoning model that spent the small budget thinking (empty reply, cut by length) is asked again with room to think', async () => {
    const budgets: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: { body: string }) => {
        const max = (JSON.parse(init.body) as { max_tokens: number }).max_tokens;
        budgets.push(max);
        return reply({ choices: [{ message: { content: max >= 400 ? 'Fix the menu' : '' }, finish_reason: max >= 400 ? 'stop' : 'length' }] });
      }),
    );
    expect(await chatOnce(openai, { system: 's', user: 'u' })).toBe('Fix the menu');
    expect(budgets).toEqual([60, 480]);
  });

  it('an empty reply that was not cut is returned as it is (no second question)', async () => {
    const f = vi.fn(async () => reply({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', f);
    expect(await chatOnce(openai, { system: 's', user: 'u' })).toBe('');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('the Anthropic style reads text blocks, and a max_tokens stop with no text is asked again too', async () => {
    const f = vi.fn().mockResolvedValueOnce(reply({ content: [], stop_reason: 'max_tokens' })).mockResolvedValueOnce(reply({ content: [{ type: 'text', text: 'Named' }], stop_reason: 'end_turn' }));
    vi.stubGlobal('fetch', f);
    expect(await chatOnce({ ...openai, style: 'anthropic' }, { system: 's', user: 'u' })).toBe('Named');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('an HTTP error is an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(chatOnce(openai, { system: 's', user: 'u' })).rejects.toThrow('HTTP 500');
  });

  it('a cut empty reply is NOT asked again when the second budget would be no bigger (it would be the same answer, paid twice)', async () => {
    const f = vi.fn(async () => reply({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
    vi.stubGlobal('fetch', f);
    expect(await chatOnce(openai, { system: 's', user: 'u', maxTokens: 1500 })).toBe('');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

