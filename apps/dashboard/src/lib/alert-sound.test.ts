import { describe, expect, it } from 'vitest';
import { ALERT_SOUNDS, DEFAULT_ALERT, parseAlertSettings, soundScore } from './alert-sound';

describe('alert sound settings', () => {
  it('a missing or broken stored value gives the defaults', () => {
    expect(parseAlertSettings(null)).toEqual(DEFAULT_ALERT);
    expect(parseAlertSettings('garbage')).toEqual(DEFAULT_ALERT);
    expect(parseAlertSettings({ sound: 'nope', volume: 'loud', enabled: 1 })).toEqual(DEFAULT_ALERT);
  });
  it('good values are kept, the volume is held between 0 and 1', () => {
    expect(parseAlertSettings({ enabled: false, sound: 'bell', volume: 0.3, questions: false, onlyWhenAway: true })).toEqual({ enabled: false, sound: 'bell', volume: 0.3, questions: false, onlyWhenAway: true });
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
