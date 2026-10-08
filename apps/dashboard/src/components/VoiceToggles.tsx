import { unlockAudio } from '@/lib/voice';
import { MicIcon, SpeakerIcon } from './VoiceIcons';
import styles from './VoiceToggles.module.css';

/** Two small switches for the chat: enter voice-only mode, and read answers aloud. `iconOnly` is for tight headers. */
export function VoiceToggles({
  stt,
  tts,
  autoSpeak,
  onAutoSpeak,
  onVoiceMode,
  className,
}: {
  stt: boolean;
  tts: boolean;
  autoSpeak: boolean;
  onAutoSpeak: (on: boolean) => void;
  onVoiceMode: () => void;
  className?: string;
}) {
  if (!stt && !tts) return null;
  return (
    <div className={`${styles.wrap} ${className ?? ''}`}>
      {stt && (
        <button
          type="button"
          className={styles.chip}
          title="Voice mode — talk instead of typing"
          aria-label="Voice mode"
          onClick={() => {
            unlockAudio();
            onVoiceMode();
          }}
        >
          <span className={styles.ico}>
            <MicIcon />
          </span>
          <span>Voice</span>
        </button>
      )}
      <span className={styles.gap} />
      {tts && (
        <button
          type="button"
          className={`${styles.chip} ${autoSpeak ? styles.on : ''}`}
          aria-pressed={autoSpeak}
          title={autoSpeak ? 'Answers are read aloud — click to turn off' : 'Read answers aloud'}
          aria-label="Read answers aloud"
          onClick={() => {
            unlockAudio();
            onAutoSpeak(!autoSpeak);
          }}
        >
          <span className={styles.ico}>
            <SpeakerIcon on={autoSpeak} />
          </span>
          <span>Speak</span>
        </button>
      )}
    </div>
  );
}
