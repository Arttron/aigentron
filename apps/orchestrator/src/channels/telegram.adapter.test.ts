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
