import { describe, expect, it } from 'vitest';
import { mergeMoments, momentsFromSpeech, POINTING_PHRASES, buildDigest, formatTime, insideRoot, isImageName, isVideoName, parseProbe, planFrames, planImage } from './media-core';

describe('names', () => {
  it('tells videos and images apart', () => {
    expect(isVideoName('Walk-through.MOV')).toBe(true);
    expect(isVideoName('a.mp4')).toBe(true);
    expect(isVideoName('a.jpg')).toBe(false);
    expect(isImageName('x.JPEG')).toBe(true);
    expect(isImageName('x.pdf')).toBe(false);
  });
});

describe('parseProbe', () => {
  it('reads duration, size and sound', () => {
    expect(parseProbe({ format: { duration: '12.5' }, streams: [{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio' }] })).toEqual({ durationSec: 12.5, width: 1920, height: 1080, hasAudio: true });
    expect(parseProbe({ format: { duration: '3' }, streams: [{ codec_type: 'video', width: 640, height: 480 }] })?.hasAudio).toBe(false);
  });
  it('rejects things that are not a video', () => {
    expect(parseProbe({ format: { duration: '3' }, streams: [{ codec_type: 'audio' }] })).toBeNull();
    expect(parseProbe({})).toBeNull();
    expect(parseProbe({ format: { duration: '0' }, streams: [{ codec_type: 'video' }] })).toBeNull();
  });
});

describe('planFrames', () => {
  it('spreads about one frame per 10 s, at least 4 and at most 24', () => {
    expect(planFrames(30)).toHaveLength(4);
    expect(planFrames(95)).toHaveLength(10);
    expect(planFrames(3600)).toHaveLength(24);
    expect(planFrames(1)).toHaveLength(1);
    expect(planFrames(0)).toEqual([]);
  });
  it('honours an explicit step, capped at 60 frames', () => {
    expect(planFrames(60, 5)).toHaveLength(12);
    expect(planFrames(60, 5)[0]).toBe(2.5);
    expect(planFrames(12, 30)).toHaveLength(1);
    expect(planFrames(1200, 1)).toHaveLength(60);
  });
  it('takes the middle of each slice, inside the video', () => {
    const t = planFrames(40);
    expect(t).toEqual([5, 15, 25, 35]);
    expect(Math.max(...planFrames(7.3))).toBeLessThan(7.3);
  });
});

describe('formatTime / buildDigest', () => {
  it('formats', () => {
    expect(formatTime(83.4)).toBe('1:23');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(0)).toBe('0:00');
  });
  it('lists frames and the transcript, or says why there is none', () => {
    const base = { name: 'room.mp4', durationSec: 40, width: 1280, height: 720, frames: [{ t: 5, path: '/x/f1.jpg' }, { t: 15, path: '/x/f2.jpg' }] };
    const withText = buildDigest({ ...base, transcript: 'This is the kitchen.' });
    expect(withText).toContain('Video: room.mp4 — 0:40, 1280×720.');
    expect(withText).toContain('- 0:05 → /x/f1.jpg');
    expect(withText).toContain('This is the kitchen.');
    expect(buildDigest({ ...base, transcript: null, transcriptNote: 'speech recognition is not set up' })).toContain('Sound: speech recognition is not set up');
  });
});

describe('insideRoot', () => {
  it('only paths under an allowed folder, no traversal', () => {
    const roots = ['/data/attachments', '/data/agent/resources'];
    expect(insideRoot('/data/attachments/t1/video.mp4', roots)).toBe(true);
    expect(insideRoot('/data/agent/resources/files/a.jpg', roots)).toBe(true);
    expect(insideRoot('/data/attachments/../secrets/auth.json', roots)).toBe(false);
    expect(insideRoot('/data/secrets/auth.json', roots)).toBe(false);
    expect(insideRoot('/data/attachmentsX/a', roots)).toBe(false);
  });
});

describe('speech moments', () => {
  const segs = [
    { start: 0, end: 4, text: 'Привет, это наша кухня.' },
    { start: 4, end: 10, text: 'Смотри, вот тут трещина в стене.' },
    { start: 10, end: 16, text: 'And look here, the pipe leaks.', words: [{ start: 10.2, end: 10.5, text: 'And' }, { start: 10.6, end: 10.9, text: 'look' }, { start: 11, end: 11.3, text: 'here,' }, { start: 11.4, end: 11.6, text: 'the' }] },
  ];
  it('finds the moments the pointing words are said', () => {
    const m = momentsFromSpeech(segs, POINTING_PHRASES);
    expect(m.length).toBeGreaterThanOrEqual(2);
    expect(m[0]!.t).toBeGreaterThanOrEqual(4);
    expect(m[0]!.t).toBeLessThan(6);
    expect(m.some((x) => Math.abs(x.t - 11) < 0.1)).toBe(true); // exact, from the word times (10.6 + 0.4)
    expect(m[0]!.why).toContain('Смотри');
  });
  it('does not match inside other words and ignores empty phrases', () => {
    expect(momentsFromSpeech([{ start: 0, end: 5, text: 'Nothing to see, an overlooked spot.' }], ['look'])).toEqual([]);
    expect(momentsFromSpeech(segs, ['', ' '])).toEqual([]);
  });
  it('merges close moments and keeps them inside the video', () => {
    const r = mergeMoments([{ t: 5 }, { t: 5.5, why: 'x' }, { t: 30 }, { t: 99 }], 20);
    expect(r.map((x) => x.t)).toEqual([5, 19.9]);
    expect(r[0]!.why).toBe('x');
  });
  it('prints a timed transcript and the words next to the frame', () => {
    const t = buildDigest({ name: 'a.mp4', durationSec: 20, width: 0, height: 0, frames: [{ t: 5, path: '/f.jpg', why: '“вот тут”' }], transcript: 'x', segments: [{ start: 65, end: 70, text: 'hello' }] });
    expect(t).toContain('(said: “вот тут”)');
    expect(t).toContain('[1:05] hello');
  });
});

describe('planImage', () => {
  const f = (o: Partial<{ ext: string; width: number; height: number; bytes: number; hasAlpha: boolean }>) => ({ ext: 'jpg', width: 4000, height: 3000, bytes: 5_000_000, hasAlpha: false, ...o });
  it('shrinks a big photo and leaves small / odd files alone', () => {
    expect(planImage(f({}), 1600)).toEqual({ action: 'recompress', toExt: 'jpg', maxSide: 1600 });
    expect(planImage(f({ width: 1200, height: 800, bytes: 120_000 }), 1600)).toEqual({ action: 'skip' });
    expect(planImage(f({ ext: 'gif' }), 1600)).toEqual({ action: 'skip' });
    expect(planImage(f({ ext: 'heic' }), 1600)).toEqual({ action: 'skip' });
  });
  it('a heavy PNG without transparency becomes a JPEG; with transparency it stays a PNG', () => {
    expect(planImage(f({ ext: 'png', width: 1500, height: 1000, bytes: 2_000_000 }), 1600)).toEqual({ action: 'recompress', toExt: 'jpg', maxSide: 1600 });
    expect(planImage(f({ ext: 'png', hasAlpha: true }), 1600)).toEqual({ action: 'recompress', toExt: 'png', maxSide: 1600 });
  });
  it('an animation is never flattened', () => {
    expect(planImage(f({ ext: 'webp', frames: 12 }), 1600)).toEqual({ action: 'skip' });
  });
  it('a big photo that is lightly compressed is still reduced when it is too wide', () => {
    expect(planImage(f({ width: 3000, height: 2000, bytes: 300_000 }), 1600).action).toBe('recompress');
  });
});

describe('empty roots and secret paths', () => {
  it('an empty root allows nothing', () => {
    expect(insideRoot('/etc/passwd', [''])).toBe(false);
    expect(insideRoot('/a/b', ['', '/a'])).toBe(true);
  });
  it('refuses sign-in tokens and env files', async () => {
    const { isSecretPath } = await import('./media-core');
    expect(isSecretPath('/d/runs/t1/codex-home/auth.json')).toBe(true);
    expect(isSecretPath('/d/runs/t1/codex-home/sessions/x.jsonl')).toBe(true);
    expect(isSecretPath('/d/.codex-home/auth.json')).toBe(true);
    expect(isSecretPath('/w/.env.local')).toBe(true);
    expect(isSecretPath('/w/.env')).toBe(true);
    expect(isSecretPath('/d/runs/t1/codex-home/generated_images/a.png')).toBe(false);
    expect(isSecretPath('/w/photo.jpg')).toBe(false);
  });
});
