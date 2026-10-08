import { useEffect, useRef, useState } from 'react';
import { Recorder, micSupported, speakText, stopSpeaking, unlockAudio, voiceApi, type VoiceSettings } from '@/lib/voice';
import { Button, ErrorText, Field, Muted } from '@/components/ui';
import styles from './VoiceSettings.module.css';

/** Hands-on check of the SAVED voice settings: hear the voice read a text, and record yourself to see what is recognised. */
export function VoiceTryout({ cfg }: { cfg: VoiceSettings | null }) {
  const [text, setText] = useState('Hello! This is how I will sound when I read an answer to you.');
  const [playing, setPlaying] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'rec' | 'busy'>('idle');
  const [heard, setHeard] = useState<string | null>(null);
  const [clip, setClip] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<Recorder | null>(null);
  const meter = useRef<HTMLDivElement>(null);
  const clipUrl = useRef<string | null>(null);

  useEffect(
    () => () => {
      rec.current?.cancel();
      stopSpeaking();
      if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
    },
    [],
  );

  const play = async () => {
    unlockAudio();
    setErr(null);
    if (playing) return void stopSpeaking();
    setPlaying(true);
    try {
      await speakText(text, (l) => meter.current?.style.setProperty('--lvl', l.toFixed(2)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPlaying(false);
    }
  };

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    meter.current?.style.setProperty('--lvl', '0');
    setPhase('busy');
    try {
      const res = await r.stop();
      if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
      clipUrl.current = res.blob.size ? URL.createObjectURL(res.blob) : null;
      setClip(clipUrl.current);
      if (!res.hadSpeech || res.ms < 500) setErr('I did not hear anything — check that the right microphone is selected and speak a little louder.');
      else setHeard((await voiceApi.transcribe(res.blob)).trim() || '(no words recognised)');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPhase('idle');
    }
  };

  const record = async () => {
    unlockAudio();
    setErr(null);
    setHeard(null);
    if (phase === 'rec') return void stop();
    if (phase === 'busy') return;
    if (!micSupported()) return setErr('This browser cannot record audio.');
    const r = new Recorder({ onLevel: (l) => meter.current?.style.setProperty('--lvl', l.toFixed(2)), autoStopAfterSilenceMs: 1800, maxMs: 60_000, onAutoStop: () => void stop() });
    rec.current = r;
    try {
      await r.start();
      setPhase('rec');
    } catch (e) {
      rec.current = null;
      setErr((e as Error).message);
    }
  };

  return (
    <div className={styles.block}>
      <strong>Try it</strong>
      <Muted>Uses the settings as last saved — press Save first if you changed something.</Muted>

      <Field label="🔊 Hear the voice">
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </Field>
      <Button disabled={!cfg?.ttsReady || !text.trim()} onClick={() => void play()}>
        {playing ? '⏹ Stop' : '▶ Play'}
      </Button>
      {!cfg?.ttsReady && <Muted> Switch on and save speech synthesis first.</Muted>}

      <div style={{ height: 12 }} />
      <Field label="🎤 Record a message (speak, then pause — it stops by itself)">
        <Button disabled={!cfg?.sttReady || phase === 'busy'} onClick={() => void record()}>
          {phase === 'rec' ? '⏹ Stop' : phase === 'busy' ? 'Recognising…' : '● Record'}
        </Button>
      </Field>
      {!cfg?.sttReady && <Muted>Switch on and save speech recognition first.</Muted>}
      <div className={styles.meter} aria-hidden>
        <div ref={meter} className={styles.meterBar} />
      </div>
      {phase === 'rec' && <Muted>Listening… the bar should move when you speak. The browser may ask for microphone permission the first time.</Muted>}
      {heard !== null && (
        <p className={styles.heard}>
          <strong>Recognised:</strong> “{heard}”
        </p>
      )}
      {clip && (
        <p>
          <Muted>Your recording:</Muted>
          <audio controls src={clip} style={{ width: '100%' }} />
        </p>
      )}
      {err && <ErrorText>{err}</ErrorText>}
    </div>
  );
}
