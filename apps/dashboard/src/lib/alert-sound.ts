/**
 * The sound the dashboard makes when an agent needs a person (an approval, a question). Synthesised in the browser (Web Audio): no sound files, nothing to
 * download, and every sound is a short "score" of notes that can be tested without a speaker. The default is a falling two-note "uh-oh", in the spirit of the old
 * instant messengers. The choice is per browser (localStorage) — a phone and an office desktop want different things.
 */

import { customIdOf, getCustomSoundData, isCustomName, MAX_SOUND_SECONDS } from './custom-sounds';

export type BuiltinSoundName = 'uhoh' | 'chime' | 'ping' | 'knock' | 'bell';
/** A built-in sound, or `custom:<id>` for one the person uploaded (lib/custom-sounds.ts). */
export type AlertSoundName = BuiltinSoundName | `custom:${string}`;

export const ALERT_SOUNDS: { id: BuiltinSoundName; label: string }[] = [
  { id: 'uhoh', label: 'Uh-oh (falling two notes, like the old messengers)' },
  { id: 'chime', label: 'Chime (two rising notes)' },
  { id: 'ping', label: 'Ping (one short high note)' },
  { id: 'knock', label: 'Knock (two soft taps)' },
  { id: 'bell', label: 'Bell (a ringing tone)' },
];

export interface AlertSettings {
  enabled: boolean;
  sound: AlertSoundName;
  /** 0–1 */
  volume: number;
  /** also when an agent asks a question (not only for approvals) */
  questions: boolean;
  /** stay quiet while this tab is the one you are looking at */
  onlyWhenAway: boolean;
  /** a sound for a new MESSAGE of an agent in the conversation you have open (never for its steps: tool calls, results of tools) */
  messages: boolean;
  messageSound: AlertSoundName;
  /** only for the agent's final answer, not for every narrated line */
  messagesOnlyFinal: boolean;
  /** only while this tab is not the one you are looking at */
  messagesOnlyWhenAway: boolean;
}

export const DEFAULT_ALERT: AlertSettings = { enabled: true, sound: 'uhoh', volume: 0.6, questions: true, onlyWhenAway: false, messages: true, messageSound: 'ping', messagesOnlyFinal: false, messagesOnlyWhenAway: false };

const KEY = 'lds.alertSound';

const clamp01 = (n: unknown, fallback: number): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback);

/** A stored value → settings, with anything missing or broken replaced by the default. */
export function parseAlertSettings(raw: unknown): AlertSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const known = ALERT_SOUNDS.some((s) => s.id === o.sound) || isCustomName(o.sound);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_ALERT.enabled,
    sound: known ? (o.sound as AlertSoundName) : DEFAULT_ALERT.sound,
    volume: clamp01(o.volume, DEFAULT_ALERT.volume),
    questions: typeof o.questions === 'boolean' ? o.questions : DEFAULT_ALERT.questions,
    onlyWhenAway: typeof o.onlyWhenAway === 'boolean' ? o.onlyWhenAway : DEFAULT_ALERT.onlyWhenAway,
    messages: typeof o.messages === 'boolean' ? o.messages : DEFAULT_ALERT.messages,
    messageSound: ALERT_SOUNDS.some((s) => s.id === o.messageSound) || isCustomName(o.messageSound) ? (o.messageSound as AlertSoundName) : DEFAULT_ALERT.messageSound,
    messagesOnlyFinal: typeof o.messagesOnlyFinal === 'boolean' ? o.messagesOnlyFinal : DEFAULT_ALERT.messagesOnlyFinal,
    messagesOnlyWhenAway: typeof o.messagesOnlyWhenAway === 'boolean' ? o.messagesOnlyWhenAway : DEFAULT_ALERT.messagesOnlyWhenAway,
  };
}

export function loadAlertSettings(): AlertSettings {
  try {
    return parseAlertSettings(JSON.parse(window.localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return DEFAULT_ALERT;
  }
}

export function saveAlertSettings(s: AlertSettings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private window: the choice lasts until the page is closed */
  }
}

/** One note of a score: a pitch gliding from `from` to `to` Hz, starting `at` ms in, lasting `ms`. */
export interface Note {
  from: number;
  to: number;
  at: number;
  ms: number;
  wave: OscillatorType;
  /** relative loudness, 0–1 */
  gain: number;
}

/** The notes of a sound. Pure: this is what the tests look at and what `playAlert` plays. */
export function soundScore(name: BuiltinSoundName): Note[] {
  switch (name) {
    case 'chime':
      return [
        { from: 659, to: 659, at: 0, ms: 160, wave: 'sine', gain: 0.9 },
        { from: 988, to: 988, at: 150, ms: 320, wave: 'sine', gain: 0.9 },
      ];
    case 'ping':
      return [{ from: 1568, to: 1568, at: 0, ms: 240, wave: 'sine', gain: 0.9 }];
    case 'knock':
      return [
        { from: 220, to: 130, at: 0, ms: 90, wave: 'triangle', gain: 1 },
        { from: 220, to: 130, at: 160, ms: 90, wave: 'triangle', gain: 1 },
      ];
    case 'bell':
      return [
        { from: 880, to: 880, at: 0, ms: 700, wave: 'sine', gain: 0.8 },
        { from: 1760, to: 1760, at: 0, ms: 450, wave: 'sine', gain: 0.35 },
        { from: 2640, to: 2640, at: 0, ms: 260, wave: 'sine', gain: 0.18 },
      ];
    case 'uhoh':
    default:
      // "uh" a little higher, "oh" a third lower and longer, each note sagging a touch like a voice
      return [
        { from: 523, to: 494, at: 0, ms: 150, wave: 'triangle', gain: 1 },
        { from: 415, to: 349, at: 190, ms: 300, wave: 'triangle', gain: 1 },
      ];
  }
}

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** Browsers keep a page silent until the person has touched it once: the first click / key / tap wakes the audio, and later alerts can play by themselves. */
export function installAlertUnlock(): () => void {
  const wake = () => void audioContext()?.resume().catch(() => undefined);
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  for (const e of events) window.addEventListener(e, wake, { passive: true });
  return () => {
    for (const e of events) window.removeEventListener(e, wake);
  };
}

/** Is the audio awake (a sound would be heard)? false until the page has been touched once. */
export function alertSoundReady(): boolean {
  return ctx?.state === 'running';
}

/** Play a sound at a volume (0–1). Resolves to false when the browser keeps the page silent. */
export async function playSound(name: AlertSoundName, volume: number): Promise<boolean> {
  const c = audioContext();
  if (!c) return false;
  if (c.state !== 'running') await c.resume().catch(() => undefined);
  if ((c.state as string) !== 'running') return false;
  const master = c.createGain();
  // the ear is not linear: 0–1 on the slider maps to a gentler curve, topping out well below clipping
  master.gain.value = Math.pow(clamp01(volume, 0.6), 2) * (customIdOf(name) ? 1 : 0.5);
  master.connect(c.destination);
  const customId = customIdOf(name);
  if (customId) {
    const buffer = await decodedCustom(c, customId);
    if (buffer) {
      const src = c.createBufferSource();
      src.buffer = buffer;
      src.connect(master);
      src.start();
      return true;
    }
    name = DEFAULT_ALERT.sound; // the uploaded file is gone (another browser profile, cleared data): the default sound instead of silence
  }
  const t0 = c.currentTime + 0.02;
  for (const n of soundScore(name as BuiltinSoundName)) {
    const osc = c.createOscillator();
    const env = c.createGain();
    const start = t0 + n.at / 1000;
    const end = start + n.ms / 1000;
    osc.type = n.wave;
    osc.frequency.setValueAtTime(n.from, start);
    if (n.to !== n.from) osc.frequency.linearRampToValueAtTime(n.to, end);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(n.gain, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(env).connect(master);
    osc.start(start);
    osc.stop(end + 0.03);
  }
  return true;
}

const decoded = new Map<string, AudioBuffer>();

/** decodeAudioData, but never waiting forever on a file the browser cannot make sense of (or an audio device that is not there). */
function decode(c: AudioContext, data: ArrayBuffer, ms = 8000): Promise<AudioBuffer> {
  return Promise.race([c.decodeAudioData(data.slice(0)), new Promise<never>((_, no) => setTimeout(() => no(new Error('decode timed out')), ms))]);
}

/** The decoded audio of an uploaded sound (cached; null when it is not there or cannot be decoded). */
async function decodedCustom(c: AudioContext, id: string): Promise<AudioBuffer | null> {
  const hit = decoded.get(id);
  if (hit) return hit;
  const data = await getCustomSoundData(id);
  if (!data) return null;
  try {
    const buf = await decode(c, data);
    decoded.set(id, buf);
    return buf;
  } catch {
    return null;
  }
}

/** Forget a decoded sound (it was removed). */
export function forgetCustomSound(id: string): void {
  decoded.delete(id);
}

/** Decode a file to check it really is audio of a sensible length; resolves to an error text, or null when it is fine. */
export async function checkSoundData(data: ArrayBuffer): Promise<string | null> {
  const c = audioContext();
  if (!c) return 'This browser cannot play sounds.';
  try {
    const buf = await decode(c, data);
    if (buf.duration > MAX_SOUND_SECONDS) return `That sound is ${buf.duration.toFixed(1)} s long — at most ${MAX_SOUND_SECONDS} s.`;
    return null;
  } catch {
    return 'The browser could not read that file as audio.';
  }
}

let lastAlertAt = 0;

/**
 * An approval (or a question) has appeared. Plays the chosen sound unless the person switched it off, or only wants it while away and is looking at this tab.
 * Alerts arriving in a burst make one sound.
 */
export function alertForRequest(kind: 'approval' | 'question', settings: AlertSettings = loadAlertSettings(), now = Date.now()): Promise<boolean> {
  if (!settings.enabled || (kind === 'question' && !settings.questions)) return Promise.resolve(false);
  if (settings.onlyWhenAway && typeof document !== 'undefined' && document.hasFocus() && !document.hidden) return Promise.resolve(false);
  if (now - lastAlertAt < 2500) return Promise.resolve(false);
  lastAlertAt = now;
  return playSound(settings.sound, settings.volume);
}

/** The kinds of conversation entries that are MESSAGES of an agent: its words and its answer (not its steps: tool calls and their results, system notes, errors). */
export const MESSAGE_KINDS: ReadonlySet<string> = new Set(['assistant', 'result', 'discussion', 'subtask_report']);

export function isMessageKind(kind: string): boolean {
  return MESSAGE_KINDS.has(kind);
}

let lastMessageAt = 0;

/**
 * A new message of an agent appeared in the conversation that is open. Sounds only for messages (isMessageKind) — the "all steps" view of the conversation
 * does not change that: a tool call is a step, not a message. Lines in a burst make one sound.
 */
export function alertForMessage(kind: string, settings: AlertSettings = loadAlertSettings(), now = Date.now()): Promise<boolean> {
  if (!settings.messages || !isMessageKind(kind)) return Promise.resolve(false);
  if (settings.messagesOnlyFinal && kind !== 'result') return Promise.resolve(false);
  if (settings.messagesOnlyWhenAway && typeof document !== 'undefined' && document.hasFocus() && !document.hidden) return Promise.resolve(false);
  if (now - lastMessageAt < 3000) return Promise.resolve(false);
  lastMessageAt = now;
  return playSound(settings.messageSound, settings.volume);
}
