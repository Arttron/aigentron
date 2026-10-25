import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramAdapter, TelegramApiError, clip, retryDelayMs } from './telegram.adapter';

type Call = { method: string; body: unknown };

/** A fake Bot API: `getUpdates` answers from `batches` (one per call, then empty until stopped), everything else `ok`. */
function fakeTelegram(batches: unknown[][], opts: { rateLimitOnce?: string } = {}) {
  const calls: Call[] = [];
  let limited = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, body });
    if (method === 'getUpdates') {
      const batch = batches.shift();
      if (!batch) {
        // nothing new: hold like a long poll until aborted
        await new Promise<void>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return new Response(JSON.stringify({ ok: true, result: batch ?? [] }));
    }
    if (opts.rateLimitOnce === method && !limited) {
      limited = true;
      return new Response(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 2 } }), { status: 429 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const msg = (update_id: number, text: string) => ({ update_id, message: { message_id: update_id * 10, text, chat: { id: 42 }, from: { id: 1, username: 'bob' } } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TelegramAdapter polling cursor (C-05)', () => {
  it('starts after the persisted update id, hands every handled update to onOffset, and skips a replayed one', async () => {
    const { calls } = fakeTelegram([[msg(5, 'old again'), msg(6, 'new'), msg(7, 'newer')]]);
    const adapter = new TelegramAdapter('t', { botToken: 'x', lastUpdateId: 5 });
    const seen: string[] = [];
    const offsets: number[] = [];
    adapter.startPolling((e) => void (e.type === 'message' && seen.push(e.text)), { onOffset: (n) => offsets.push(n) });
    await vi.waitFor(() => expect(seen).toEqual(['new', 'newer']));
    expect(calls.find((c) => c.method === 'getUpdates')!.body).toMatchObject({ offset: 6 });
    expect(offsets).toEqual([6, 7]);
    await adapter.stop();
  });

  it('without a persisted id it starts from 0; stop() resolves once the loop has ended', async () => {
    const { calls } = fakeTelegram([[msg(1, 'a')]]);
    const adapter = new TelegramAdapter('t', { botToken: 'x' });
    const seen: string[] = [];
    adapter.startPolling((e) => void (e.type === 'message' && seen.push(e.text)));
    await vi.waitFor(() => expect(seen).toEqual(['a']));
    expect(calls.find((c) => c.method === 'getUpdates')!.body).toMatchObject({ offset: 0 });
    await adapter.stop();
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(n); // no more polling after stop
  });
});

describe('TelegramAdapter outgoing requests', () => {
  it('retries a 429 after retry_after (C-08)', async () => {
    vi.useFakeTimers();
    const { calls } = fakeTelegram([], { rateLimitOnce: 'sendMessage' });
    const adapter = new TelegramAdapter('t', { botToken: 'x' });
    const p = adapter.sendMessage('42', 'hi');
    await vi.advanceTimersByTimeAsync(2500);
    expect(await p).toEqual({ messageId: '7' });
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);
  });

  it('every request carries a timeout signal (C-07)', async () => {
    const { fetchMock } = fakeTelegram([]);
    const adapter = new TelegramAdapter('t', { botToken: 'x' });
    await adapter.sendMessage('42', 'hi');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retryDelayMs: only a 429 is retried, bounded, at most twice', () => {
    expect(retryDelayMs(new TelegramApiError('x', 429, 3), 0)).toBe(3000);
    expect(retryDelayMs(new TelegramApiError('x', 429, 999), 0)).toBe(30_000);
    expect(retryDelayMs(new TelegramApiError('x', 429), 1)).toBe(1000);
    expect(retryDelayMs(new TelegramApiError('x', 429, 3), 2)).toBeNull();
    expect(retryDelayMs(new TelegramApiError('x', 400), 0)).toBeNull();
    expect(retryDelayMs(new Error('net'), 0)).toBeNull();
  });

  it('clip never splits a surrogate pair', () => {
    expect(clip('abc', 10)).toBe('abc');
    expect(clip('ab😀cd', 4)).toBe('ab…');
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});

describe('TelegramAdapter formatting', () => {
  const adapter = () => new TelegramAdapter('t', { botToken: 'x' });
  it('sends the text as HTML with file names in <code> (so progress.md is not a link)', async () => {
    const { calls } = fakeTelegram([]);
    await adapter().sendMessage('42', '**Done**: updated english/plan.md and progress.md');
    const sent = calls.find((c) => c.method === 'sendMessage')!.body as { text: string; parse_mode: string };
    expect(sent.parse_mode).toBe('HTML');
    expect(sent.text).toBe('<b>Done</b>: updated <code>english/plan.md</code> and <code>progress.md</code>');
  });
  it('when Telegram refuses the markup the same text is sent plain', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ body });
      return body.parse_mode
        ? new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities: Can't find end of the entity" }), { status: 400 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }));
    }));
    const r = await adapter().sendMessage('42', 'hello **x**');
    expect(r.messageId).toBe('9');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.parse_mode).toBeUndefined();
    expect(calls[1]!.body.text).toBe('hello **x**');
  });
});

describe('TelegramAdapter.probeSender ("find my id")', () => {
  it('forgets older messages, waits for a new one, confirms it and says who wrote what', async () => {
    const calls: { offset?: number; timeout?: number }[] = [];
    const answers = [
      [{ update_id: 5, message: { message_id: 1, text: 'old', chat: { id: 1 }, from: { id: 1 } } }], // before the call: skipped
      [], // nothing yet
      [{ update_id: 6, message: { message_id: 2, text: 'hello bot', chat: { id: 4242 }, from: { id: 4242, username: 'bob', first_name: 'Bob' } } }],
      [], // the confirmation
    ];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: answers.shift() ?? [] }));
    }));
    const r = await new TelegramAdapter('t', { botToken: 'x' }).probeSender(20);
    expect(r).toEqual({ chatId: '4242', userId: '4242', userName: '@bob', chatTitle: undefined, text: 'hello bot' });
    expect(calls[0]).toMatchObject({ offset: -1, timeout: 0 });
    expect(calls[1]).toMatchObject({ offset: 6 }); // the old update 5 is confirmed
    expect(calls[3]).toMatchObject({ offset: 7, timeout: 0 }); // the new one is confirmed, so the channel never sees it
  });
  it('a group message gives the group chat id; a photo has no text', async () => {
    const answers = [[], [{ update_id: 1, message: { message_id: 2, chat: { id: -100123, title: 'Team' }, from: { id: 7, first_name: 'Ann' }, photo: [{ file_id: 'f' }] } }], []];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: answers.shift() ?? [] }))));
    const r = await new TelegramAdapter('t', { botToken: 'x' }).probeSender(20);
    expect(r).toMatchObject({ chatId: '-100123', userId: '7', userName: 'Ann', chatTitle: 'Team' });
    expect(r?.text).toContain('no text');
  });
  it('a bot that something else is reading gets a clear message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'Conflict: terminated by other getUpdates request' }), { status: 409 })));
    await expect(new TelegramAdapter('t', { botToken: 'x' }).probeSender(5)).rejects.toThrow(/reading this bot/);
  });
  it('nothing written in time → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: [] }))));
    expect(await new TelegramAdapter('t', { botToken: 'x' }).probeSender(1)).toBeNull();
  });
});
