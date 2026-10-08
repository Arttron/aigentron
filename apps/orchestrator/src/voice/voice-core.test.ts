import { describe, expect, it } from 'vitest';
import { audioFileName, isOggOpus, parseVoiceConfig, speechText } from './voice-core';

describe('parseVoiceConfig', () => {
  it('accepts a full config and fills defaults', () => {
    const r = parseVoiceConfig({ stt: { provider: 'openai-voice', model: 'gpt-4o-mini-transcribe', language: 'RU' }, tts: { provider: 'openai-voice', model: 'gpt-4o-mini-tts' } });
    expect(r.config).toEqual({
      stt: { provider: 'openai-voice', model: 'gpt-4o-mini-transcribe', language: 'ru' },
      tts: { provider: 'openai-voice', model: 'gpt-4o-mini-tts', voice: 'alloy', maxChars: 1500 },
    });
  });
  it('an empty half means off', () => {
    expect(parseVoiceConfig({ stt: { provider: '', model: '' }, tts: null }).config).toEqual({ stt: null, tts: null });
    expect(parseVoiceConfig(undefined).config).toEqual({ stt: null, tts: null });
  });
  it('says what is missing or malformed', () => {
    expect(parseVoiceConfig({ stt: { provider: 'p', model: '' } }).error).toMatch(/model/);
    expect(parseVoiceConfig({ stt: { provider: '', model: 'm' } }).error).toMatch(/provider/);
    expect(parseVoiceConfig({ stt: { provider: 'p', model: 'm', language: 'russian' } }).error).toMatch(/language/);
    expect(parseVoiceConfig({ tts: { provider: 'p', model: '' } }).error).toMatch(/model/);
  });
  it('caps the spoken length', () => {
    expect(parseVoiceConfig({ tts: { provider: 'p', model: 'm', maxChars: 999999 } }).config!.tts!.maxChars).toBe(4000);
    expect(parseVoiceConfig({ tts: { provider: 'p', model: 'm', maxChars: -3 } }).config!.tts!.maxChars).toBe(1500);
  });
});

describe('speechText', () => {
  it('drops code, links, markdown marks, headings and emoji', () => {
    const md = '## Plan ✅\n\n**Step one:** open [the docs](https://x.dev/a) and run `npm test`.\n\n```ts\nconst a = 1;\n```\n\n- first item\n- second item\n\nSee https://example.com/very/long now 🚀';
    const { text } = speechText(md);
    expect(text).not.toMatch(/[`#*[\]]|https?:|const a/);
    expect(text).toContain('Step one: open the docs and run npm test.');
    expect(text).toContain('code omitted');
    expect(text).toContain('first item');
    expect(text).toContain('See link now');
    expect(text).not.toMatch(/✅|🚀/);
  });
  it('leaves short plain text alone', () => {
    expect(speechText('Hello there. All good.')).toEqual({ text: 'Hello there. All good.', truncated: false });
  });
  it('cuts long text at a sentence end and says it was cut', () => {
    const long = 'First sentence is here. '.repeat(100);
    const r = speechText(long, 200);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(200);
    expect(r.text.endsWith('.')).toBe(true);
  });
  it('cuts a sentence-less text at a word, with an ellipsis', () => {
    const r = speechText('word '.repeat(200), 50);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith('…')).toBe(true);
  });
});

describe('audio naming', () => {
  it('chooses an extension the API understands', () => {
    expect(audioFileName('audio/ogg; codecs=opus')).toBe('voice.ogg');
    expect(audioFileName('audio/webm;codecs=opus')).toBe('voice.webm');
    expect(audioFileName('audio/mp4')).toBe('voice.m4a');
    expect(audioFileName(undefined)).toBe('voice.ogg');
  });
  it('recognises Ogg/Opus', () => {
    expect(isOggOpus('audio/ogg')).toBe(true);
    expect(isOggOpus('audio/mpeg')).toBe(false);
  });
});
