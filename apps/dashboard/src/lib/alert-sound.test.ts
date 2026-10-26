import { describe, expect, it } from 'vitest';
import { MAX_CUSTOM_SOUNDS, customIdOf, isCustomName, validateSoundFile } from './custom-sounds';
import { ALERT_SOUNDS, alertForMessage, isMessageKind, DEFAULT_ALERT, parseAlertSettings, soundScore } from './alert-sound';

describe('alert sound settings', () => {
  it('a missing or broken stored value gives the defaults', () => {
    expect(parseAlertSettings(null)).toEqual(DEFAULT_ALERT);
    expect(parseAlertSettings('garbage')).toEqual(DEFAULT_ALERT);
    expect(parseAlertSettings({ sound: 'nope', volume: 'loud', enabled: 1 })).toEqual(DEFAULT_ALERT);
  });
  it('good values are kept, the volume is held between 0 and 1', () => {
    expect(parseAlertSettings({ enabled: false, sound: 'bell', volume: 0.3, questions: false, onlyWhenAway: true })).toMatchObject({ enabled: false, sound: 'bell', volume: 0.3, questions: false, onlyWhenAway: true });
    expect(parseAlertSettings({ volume: 7 }).volume).toBe(1);
    expect(parseAlertSettings({ volume: -2 }).volume).toBe(0);
  });
});

describe('the sounds', () => {
  it('every offered sound has a score of notes inside the audible range and in time order', () => {
    for (const { id } of ALERT_SOUNDS) {
      const notes = soundScore(id);
      expect(notes.length).toBeGreaterThan(0);
      for (const n of notes) {
        expect(n.from).toBeGreaterThan(80);
        expect(n.to).toBeLessThan(4000);
        expect(n.ms).toBeGreaterThan(40);
        expect(n.gain).toBeGreaterThan(0);
        expect(n.gain).toBeLessThanOrEqual(1);
      }
      const starts = notes.map((n) => n.at);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    }
  });
  it('the default is a falling two-note "uh-oh" under a second long', () => {
    const [a, b] = soundScore('uhoh');
    expect(soundScore('uhoh')).toHaveLength(2);
    expect(b!.from).toBeLessThan(a!.to); // the second note is lower
    expect(b!.at + b!.ms).toBeLessThan(1000);
  });
});

describe('uploaded sounds', () => {
  it('a custom sound id is accepted in the stored settings, a broken one is not', () => {
    expect(parseAlertSettings({ sound: 'custom:sk3j9abc' }).sound).toBe('custom:sk3j9abc');
    expect(parseAlertSettings({ sound: 'custom:' }).sound).toBe('uhoh');
    expect(parseAlertSettings({ sound: 'custom:../../x' }).sound).toBe('uhoh');
  });
});

describe('which files may become a sound', () => {
  const f = (name: string, size: number, type = '') => ({ name, size, type });
  it('audio of a sensible size is fine', () => {
    expect(validateSoundFile(f('ding.mp3', 50_000, 'audio/mpeg'), 0)).toBeNull();
    expect(validateSoundFile(f('ding.m4a', 50_000), 0)).toBeNull(); // no type given: the extension decides
  });
  it('anything else says why not', () => {
    expect(validateSoundFile(f('cat.png', 1000, 'image/png'), 0)).toMatch(/not an audio/);
    expect(validateSoundFile(f('big.wav', 5_000_000, 'audio/wav'), 0)).toMatch(/at most/);
    expect(validateSoundFile(f('empty.mp3', 0, 'audio/mpeg'), 0)).toMatch(/empty/);
    expect(validateSoundFile(f('one.mp3', 1000, 'audio/mpeg'), MAX_CUSTOM_SOUNDS)).toMatch(/remove one first/);
  });
  it('names of custom sounds', () => {
    expect(customIdOf('custom:abc123')).toBe('abc123');
    expect(customIdOf('uhoh')).toBeNull();
    expect(isCustomName('custom:abc123')).toBe(true);
    expect(isCustomName('custom:')).toBe(false);
  });
});

describe('sounds for messages (not for steps)', () => {
  it('only an agent\'s words and answers are messages', () => {
    for (const k of ['assistant', 'result', 'discussion', 'subtask_report']) expect(isMessageKind(k), k).toBe(true);
    for (const k of ['tool_use', 'tool_result', 'delegation', 'system', 'stderr', 'prompt']) expect(isMessageKind(k), k).toBe(false);
  });
  it('a step never plays, whatever the settings', async () => {
    for (const k of ['tool_use', 'tool_result', 'delegation', 'system', 'stderr', 'prompt']) expect(await alertForMessage(k, { ...DEFAULT_ALERT, messages: true }, 1_000_000)).toBe(false);
  });
  it('off, or "only the final answer", stays quiet for the rest', async () => {
    expect(await alertForMessage('result', { ...DEFAULT_ALERT, messages: false }, 2_000_000)).toBe(false);
    expect(await alertForMessage('assistant', { ...DEFAULT_ALERT, messagesOnlyFinal: true }, 3_000_000)).toBe(false);
  });
  it('the stored settings carry the message options, with defaults for older ones', () => {
    expect(parseAlertSettings({}).messages).toBe(true);
    expect(parseAlertSettings({}).messageSound).toBe('ping');
    expect(parseAlertSettings({ messages: false, messageSound: 'bell', messagesOnlyFinal: true, messagesOnlyWhenAway: true })).toMatchObject({ messages: false, messageSound: 'bell', messagesOnlyFinal: true, messagesOnlyWhenAway: true });
    expect(parseAlertSettings({ messageSound: 'nope' }).messageSound).toBe('ping');
  });
});
