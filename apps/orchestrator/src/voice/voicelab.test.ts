import { describe, expect, it } from 'vitest';
import { apiRoot, isVoicelabBase, vlError, vlParseTranscript, vlSynthesize, vlTranscribe, vlVoices } from './voicelab';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wav = () => new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { 'content-type': 'audio/wav' } });
const ctx = (fetch: typeof globalThis.fetch) => ({ base: 'https://api.voicelab.uz/v1', headers: { authorization: 'Bearer k' }, fetch, pollMs: 1, maxWaitMs: 200 });

describe('addresses', () => {
  it('recognises the service and builds the root', () => {
    expect(isVoicelabBase('https://api.voicelab.uz/v1')).toBe(true);
    expect(isVoicelabBase('https://api.openai.com/v1')).toBe(false);
    expect(isVoicelabBase('https://voicelab.uz.evil.com/v1')).toBe(false);
    expect(apiRoot('https://api.voicelab.uz')).toBe('https://api.voicelab.uz/v1');
    expect(apiRoot('https://api.voicelab.uz/v1/')).toBe('https://api.voicelab.uz/v1');
  });
  it('errors say what to do', () => {
    expect(vlError(402, '{"error":{"message":"no credits"}}')).toContain('credits');
    expect(vlError(401, 'nope')).toContain('API key');
  });
});

describe('synthesis', () => {
  it('sends the documented body and returns the audio', async () => {
    let seen: { url: string; body: Record<string, unknown>; auth: string | null } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') };
      return wav();
    }) as unknown as typeof fetch;
    const audio = await vlSynthesize(ctx(f), { text: 'Salom', language: 'uz', voiceId: 'v1' });
    expect(audio.length).toBe(4);
    expect(seen).toEqual({ url: 'https://api.voicelab.uz/v1/tts', body: { text: 'Salom', language: 'uz', voice_id: 'v1' }, auth: 'Bearer k' });
  });
  it('follows a job until the audio is ready', async () => {
    let n = 0;
    const f = (async (url: string) => {
      if (url.endsWith('/tts')) return json({ id: 'gen_1', status: 'queued', status_url: '/v1/tts/generations/gen_1' }, 202);
      if (url.endsWith('/gen_1')) return ++n < 2 ? json({ status: 'processing', status_url: '/v1/tts/generations/gen_1' }) : json({ status: 'completed', audio_url: '/v1/files/a.wav' });
      return wav();
    }) as unknown as typeof fetch;
    expect((await vlSynthesize(ctx(f), { text: 'x', language: 'en', voiceId: 'v' })).length).toBe(4);
  });
  it('an error response becomes a readable message', async () => {
    const f = (async () => json({ error: { message: 'insufficient credits' } }, 402)) as unknown as typeof fetch;
    await expect(vlSynthesize(ctx(f), { text: 'x', language: 'en', voiceId: 'v' })).rejects.toThrow(/credits/);
  });
});

describe('recognition', () => {
  it('uploads with an idempotency key and polls until the text is ready', async () => {
    const calls: string[] = [];
    let key: string | null = null;
    let field: string[] = [];
    let n = 0;
    const f = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (init.method === 'POST') {
        key = new Headers(init.headers).get('idempotency-key');
        field = [...(init.body as FormData).keys()];
        return json({ id: 'tr1', status: 'queued' }, 202);
      }
      return ++n < 2 ? json({ id: 'tr1', status: 'processing' }) : json({ id: 'tr1', status: 'completed', transcript: 'Assalomu alaykum', segments: [{ ordinal: 1, start_ms: 120, end_ms: 1320, text: 'Assalomu alaykum' }] });
    }) as unknown as typeof fetch;
    const r = await vlTranscribe(ctx(f), { data: Buffer.from('x'), mime: 'audio/ogg', fileName: 'voice.ogg', language: 'uz' });
    expect(r.text).toBe('Assalomu alaykum');
    expect(r.segments).toEqual([{ start: 0.12, end: 1.32, text: 'Assalomu alaykum' }]);
    expect(field).toEqual(['audio', 'language']);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]).toBe('POST https://api.voicelab.uz/v1/stt');
    expect(calls[1]).toBe('GET https://api.voicelab.uz/v1/stt/transcriptions/tr1');
  });
  it('a failed job and a job that never ends are errors', async () => {
    const bad = (async (_u: string, init: RequestInit) => (init.method === 'POST' ? json({ id: 'a', status: 'queued' }) : json({ status: 'failed', error: 'bad audio' }))) as unknown as typeof fetch;
    await expect(vlTranscribe(ctx(bad), { data: Buffer.from('x'), mime: 'audio/ogg', fileName: 'v.ogg' })).rejects.toThrow(/bad audio/);
    const slow = (async () => json({ id: 'a', status: 'processing' })) as unknown as typeof fetch;
    await expect(vlTranscribe(ctx(slow), { data: Buffer.from('x'), mime: 'audio/ogg', fileName: 'v.ogg' })).rejects.toThrow(/in time/);
  });
  it('reads the text from several shapes', () => {
    expect(vlParseTranscript({ text: ' hi ' })?.text).toBe('hi');
    expect(vlParseTranscript({ result: { transcript: 'a b' } })?.text).toBe('a b');
    expect(vlParseTranscript({ segments: [{ start: 0, text: 'x' }, { start: 1, end: 2, text: 'y' }] })?.text).toBe('x y');
    expect(vlParseTranscript({ status: 'processing' })).toBeNull();
  });
});

describe('voices', () => {
  it('reads the catalog in either envelope', async () => {
    const a = (async () => json({ voices: [{ voiceId: 'voice_1', name: 'Nilufar', language: 'uz' }, { id: 'voice_2' }] })) as unknown as typeof fetch;
    expect(await vlVoices(ctx(a))).toEqual([{ id: 'voice_1', name: 'Nilufar', language: 'uz' }, { id: 'voice_2', name: 'voice_2', language: undefined }]);
    const b = (async () => json([{ id: 'x', name: 'X' }])) as unknown as typeof fetch;
    expect((await vlVoices(ctx(b)))[0]!.id).toBe('x');
  });
});
