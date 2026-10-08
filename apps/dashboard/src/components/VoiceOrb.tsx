import { forwardRef } from 'react';
import styles from './VoiceMode.module.css';

export type OrbState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';

/**
 * An abstract indicator of the voice conversation — no words, just a living shape: calm when idle, swelling with your voice
 * while it listens, a shimmer while it recognises, an orbiting arc while the agent works, ripples while it speaks.
 * The parent drives `--lvl` (0–1 loudness) directly on the element, so the animation never re-renders React.
 */
export const VoiceOrb = forwardRef<
  HTMLButtonElement,
  { state: OrbState; onTap: () => void; label: string }
>(function VoiceOrb({ state, onTap, label }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={styles.orb}
      data-state={state}
      onClick={onTap}
      aria-label={label}
      aria-live="polite"
    >
      <span className={styles.ripple} />
      <span className={styles.ripple2} />
      <span className={styles.core} />
      <span className={styles.arc} />
    </button>
  );
});
