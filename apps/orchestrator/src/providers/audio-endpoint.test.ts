import { describe, expect, it } from 'vitest';
import { isKeylessAudioHost } from './audio-endpoint';

describe('isKeylessAudioHost', () => {
  it('allows this machine and the local network', () => {
    for (const u of ['http://localhost:8000/v1', 'http://127.0.0.1:8000', 'http://host.docker.internal:8000/v1', 'http://whisper:9000/v1', 'http://192.168.1.10:8000/v1', 'http://10.0.0.7/v1', 'http://172.20.1.2:8000', 'http://[::1]:8000']) {
      expect(isKeylessAudioHost(u), u).toBe(true);
    }
  });
  it('requires a key for public hosts', () => {
    for (const u of ['https://api.openai.com/v1', 'https://api.groq.com/openai/v1', 'http://8.8.8.8/v1', 'http://172.32.0.1/v1', 'http://example.com', 'not a url']) {
      expect(isKeylessAudioHost(u), u).toBe(false);
    }
  });
});
