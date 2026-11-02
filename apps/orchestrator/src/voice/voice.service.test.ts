import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VoiceService } from './voice.service';

/** An OpenAI-style audio server on localhost: the path every provider except VoiceLab takes must keep working as before. */
let server: Server;
let base = '';
const seen: { url: string; body: string; auth?: string }[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      seen.push({ url: req.url ?? '', body, auth: req.headers.authorization });
      if (req.url === '/audio/transcriptions') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ text: 'privet mir' }));
      } else if (req.url === '/audio/speech') {
        res.setHeader('content-type', 'audio/mpeg');
        res.end(Buffer.from('ID3-fake-mp3'));
      } else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const make = () => {
  const config = { secretsDir: mkdtempSync(join(tmpdir(), 'voice-')) };
  const providers = { audioEndpoint: async () => ({ base, headers: { authorization: 'Bearer sk-test' } }) };
  const v = new VoiceService(config as never, providers as never);
  return v;
};

describe('an OpenAI-style provider (not VoiceLab)', () => {
  it('recognises speech through /audio/transcriptions', async () => {
    const v = make();
    await v.save({ stt: { provider: 'openai', model: 'whisper-1', language: 'ru' } });
    seen.length = 0;
    expect(await v.transcribe(Buffer.from('fake-audio'), 'audio/ogg')).toBe('privet mir');
    expect(seen[0]!.url).toBe('/audio/transcriptions');
    expect(seen[0]!.auth).toBe('Bearer sk-test');
    expect(seen[0]!.body).toContain('name="model"');
    expect(seen[0]!.body).toContain('name="file"');
  });
  it('speaks through /audio/speech as MP3', async () => {
    const v = make();
    await v.save({ tts: { provider: 'openai', model: 'tts-1', voice: 'alloy' } });
    seen.length = 0;
    const r = await v.speak('Hello there, this is a test.', 'mp3');
    expect(r.mime).toBe('audio/mpeg');
    expect(r.audio.toString()).toBe('ID3-fake-mp3');
    expect(seen[0]!.url).toBe('/audio/speech');
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ model: 'tts-1', voice: 'alloy', response_format: 'mp3' });
  });
});

describe('the two halves can use different providers', () => {
  it('the settings keep each half on its own provider', async () => {
    const v = make();
    const c = await v.save({ stt: { provider: 'groq', model: 'whisper-large-v3-turbo', language: '' }, tts: { provider: 'voicelab', model: 'voicelab', voice: 'voice_1', language: 'uz' } });
    expect(c.stt?.provider).toBe('groq');
    expect(c.tts).toMatchObject({ provider: 'voicelab', language: 'uz' });
  });
});
