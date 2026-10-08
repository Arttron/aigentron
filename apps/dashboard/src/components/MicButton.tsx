import { useEffect, useRef, useState } from 'react';
import { Recorder, micSupported, unlockAudio, useVoice, voiceApi } from '@/lib/voice';
import { MicIcon } from './VoiceIcons';
import styles from './VoiceButtons.module.css';

/**
 * 🎤 Dictation: record, pause, and the recognised words are handed to `onText` (to be added to the text box for you to check
 * and send). Hidden until speech recognition is set up.
 */
export function MicButton({
  onText,
  onError,
  className,
}: {
  onText: (text: string) => void;
  onError?: (message: string) => void;
  className?: string;
}) {
  const voice = useVoice();
  const [phase, setPhase] = useState<'idle' | 'rec' | 'busy'>('idle');
  const rec = useRef<Recorder | null>(null);
  const bar = useRef<HTMLSpanElement>(null);

  useEffect(() => () => rec.current?.cancel(), []);
  if (!voice?.sttReady) return null;

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    bar.current?.style.setProperty('--lvl', '0');
    setPhase('busy');
    try {
      const res = await r.stop();
      if (!res.hadSpeech || res.ms < 500) return;
      const text = (await voiceApi.transcribe(res.blob)).trim();
      if (text) onText(text);
      else onError?.('I could not make out any words.');
    } catch (e) {
      onError?.((e as Error).message);
    } finally {
      setPhase('idle');
    }
  };

  const toggle = async () => {
    unlockAudio();
    if (phase === 'rec') return void stop();
    if (phase === 'busy') return;
    if (!micSupported()) return onError?.('This browser cannot record audio.');
    const r = new Recorder({
      onLevel: (l) => bar.current?.style.setProperty('--lvl', l.toFixed(2)),
      autoStopAfterSilenceMs: 1800,
      maxMs: 120_000,
      onAutoStop: () => void stop(),
    });
    rec.current = r;
    try {
      await r.start();
      setPhase('rec');
    } catch (e) {
      rec.current = null;
      onError?.((e as Error).message);
    }
  };

  return (
    <button
      type="button"
      className={`${styles.mic} ${phase === 'rec' ? styles.rec : ''} ${className ?? ''}`}
      onClick={() => void toggle()}
      disabled={phase === 'busy'}
      aria-label={phase === 'rec' ? 'Stop recording' : 'Dictate a message'}
      title={
        phase === 'rec' ? 'Stop' : phase === 'busy' ? 'Recognising…' : 'Dictate (speak, then pause)'
      }
    >
      <span ref={bar} className={styles.dot} aria-hidden />
      {phase === 'busy' ? '…' : phase === 'rec' ? '⏹' : <MicIcon />}
    </button>
  );
}
