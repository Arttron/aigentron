import { useEffect, useRef, useState } from 'react';
import { speakText, stopSpeaking, unlockAudio, useVoice } from '@/lib/voice';
import styles from './VoiceButtons.module.css';

/** 🔊 Read this message aloud (server-side text-to-speech); tap again to stop. Hidden until text-to-speech is set up. */
export function SpeakButton({
  text,
  className,
  abs,
}: {
  text: string;
  className?: string;
  abs?: boolean;
}) {
  const voice = useVoice();
  const [phase, setPhase] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!voice?.ttsReady) return null;

  const click = async () => {
    unlockAudio();
    if (phase !== 'idle') {
      stopSpeaking();
      return setPhase('idle');
    }
    setErr(null);
    setPhase('loading');
    try {
      const p = speakText(text);
      setPhase('playing');
      await p;
    } catch (e) {
      if (alive.current) setErr((e as Error).message);
    } finally {
      if (alive.current) setPhase('idle');
    }
  };

  return (
    <button
      type="button"
      className={`${styles.speak} ${abs ? styles.speakAbs : ''} ${className ?? ''}`}
      onClick={() => void click()}
      title={err ?? (phase === 'idle' ? 'Read aloud' : 'Stop')}
      aria-label={phase === 'idle' ? 'Read aloud' : 'Stop reading'}
    >
      {err ? '⚠' : phase === 'loading' ? '…' : phase === 'playing' ? '⏹' : '🔊'}
    </button>
  );
}
