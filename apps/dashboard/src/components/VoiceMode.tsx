import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Recorder,
  speakText,
  stopSpeaking,
  unlockAudio,
  useAutoSpeak,
  useKeepListening,
  useVoice,
  voiceApi,
} from '@/lib/voice';
import { VoiceOrb, type OrbState } from './VoiceOrb';
import { KeyboardIcon, RepeatIcon, SpeakerIcon } from './VoiceIcons';
import styles from './VoiceMode.module.css';

export interface VoiceReply {
  id: string;
  text: string;
}

const LABEL: Record<OrbState, string> = {
  idle: 'Tap and speak',
  listening: 'Listening… tap when done',
  transcribing: 'Recognising…',
  thinking: 'Thinking…',
  speaking: 'Speaking… tap to interrupt',
  error: 'Tap to try again',
};

/**
 * Voice-only chat. The text box is replaced by a single indicator: tap, speak, pause — your words are recognised, sent, and the
 * answer is read back. Optionally it keeps listening after each answer so it works hands-free.
 *  - `reply`: the latest answer of the agent (a new `id` = a new answer to speak);
 *  - `working`: the agent is busy on it right now.
 */
export function VoiceMode({
  onSend,
  reply,
  working,
  onClose,
}: {
  onSend: (text: string) => Promise<void>;
  reply: VoiceReply | null;
  working: boolean;
  onClose: () => void;
}) {
  const voice = useVoice();
  const [autoSpeak, setAutoSpeak] = useAutoSpeak();
  const [keep, setKeep] = useKeepListening();
  const [phase, setPhase] = useState<OrbState>('idle');
  const [heard, setHeard] = useState('');
  const [shown, setShown] = useState('');
  const [error, setError] = useState<string | null>(null);
  const orb = useRef<HTMLButtonElement>(null);
  const rec = useRef<Recorder | null>(null);
  const awaiting = useRef(false);
  const baseline = useRef<string | null>(reply?.id ?? null);
  const alive = useRef(true);
  const phaseRef = useRef<OrbState>('idle');
  const go = useCallback((p: OrbState) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);
  const level = useCallback(
    (l: number) => orb.current?.style.setProperty('--lvl', l.toFixed(3)),
    [],
  );
  const speakAnswers = autoSpeak && !!voice?.ttsReady;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      rec.current?.cancel();
      stopSpeaking();
    };
  }, []);

  const finish = useCallback(async () => {
    const r = rec.current;
    if (!r || phaseRef.current !== 'listening') return;
    rec.current = null;
    level(0);
    const res = await r.stop();
    if (!alive.current) return;
    if (!res.hadSpeech || res.ms < 600) return go('idle');
    go('transcribing');
    try {
      const text = (await voiceApi.transcribe(res.blob)).trim();
      if (!alive.current) return;
      if (!text) {
        setError('I could not make out any words.');
        return go('error');
      }
      setHeard(text);
      setError(null);
      awaiting.current = true;
      go('thinking');
      await onSend(text);
    } catch (e) {
      awaiting.current = false;
      setError((e as Error).message);
      go('error');
    }
  }, [go, level, onSend]);

  const listen = useCallback(async () => {
    stopSpeaking();
    setError(null);
    const r = new Recorder({
      onLevel: level,
      autoStopAfterSilenceMs: 1400,
      maxMs: 60_000,
      onAutoStop: () => void finish(),
    });
    rec.current = r;
    try {
      await r.start();
      go('listening');
    } catch (e) {
      rec.current = null;
      setError((e as Error).message);
      go('error');
    }
  }, [finish, go, level]);

  // A new answer arrived: show it, speak it, and (optionally) listen again.
  useEffect(() => {
    if (!reply || reply.id === baseline.current) return;
    baseline.current = reply.id;
    if (!awaiting.current) return;
    awaiting.current = false;
    setShown(reply.text);
    if (!speakAnswers) return go('idle');
    go('speaking');
    speakText(reply.text, level)
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        if (!alive.current) return;
        if (keep && phaseRef.current === 'speaking') void listen();
        else if (phaseRef.current === 'speaking') go('idle');
      });
  }, [reply, speakAnswers, keep, go, level, listen]);

  // The agent finished without a spoken/new answer (e.g. it is waiting for approval): don't spin forever.
  useEffect(() => {
    if (working || !awaiting.current || phase !== 'thinking') return;
    const t = setTimeout(() => {
      if (awaiting.current && phaseRef.current === 'thinking') {
        awaiting.current = false;
        go('idle');
      }
    }, 6000);
    return () => clearTimeout(t);
  }, [working, phase, go]);

  const tap = () => {
    unlockAudio(); // a tap is the user gesture that lets later answers play by themselves
    if (phase === 'idle' || phase === 'error') void listen();
    else if (phase === 'listening') void finish();
    else if (phase === 'speaking') void listen();
  };

  const shownPhase: OrbState = phase === 'idle' && working ? 'thinking' : phase;
  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.chip}
          onClick={onClose}
          title="Back to the keyboard"
          aria-label="Type instead"
        >
          <span className={styles.ico}>
            <KeyboardIcon />
          </span>
          <span>Type</span>
        </button>
        <span className={styles.gap} />
        <button
          type="button"
          className={`${styles.chip} ${autoSpeak ? styles.on : ''}`}
          aria-pressed={autoSpeak}
          disabled={!voice?.ttsReady}
          onClick={() => (unlockAudio(), setAutoSpeak(!autoSpeak))}
          title="Speak answers aloud"
        >
          <span className={styles.ico}>
            <SpeakerIcon on={autoSpeak} />
          </span>
          <span>Speak</span>
        </button>
        <button
          type="button"
          className={`${styles.chip} ${keep ? styles.on : ''}`}
          aria-pressed={keep}
          onClick={() => setKeep(!keep)}
          title="Listen again after each answer"
        >
          <span className={styles.ico}>
            <RepeatIcon />
          </span>
          <span>Keep listening</span>
        </button>
      </div>
      <VoiceOrb ref={orb} state={shownPhase} onTap={tap} label={LABEL[shownPhase]} />
      <div className={styles.label}>
        {error && shownPhase === 'error' ? error : LABEL[shownPhase]}
      </div>
      {/* fixed-size area: what you said / the answer scroll inside it, so nothing above or below ever moves */}
      <div className={styles.stage}>
        {heard && <div className={styles.heard}>🎤 {heard}</div>}
        {shown && <div className={styles.answer}>{shown}</div>}
        {voice && !voice.ttsReady && (
          <div className={styles.hint}>
            Answers are shown as text — turn on text-to-speech in Settings → Voice to hear them.
          </div>
        )}
      </div>
    </div>
  );
}
