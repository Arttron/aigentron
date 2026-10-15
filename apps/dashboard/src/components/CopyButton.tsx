import { useEffect, useRef, useState } from 'react';
import styles from './CopyButton.module.css';

/** Copies text to the clipboard — also on plain-HTTP origins, where `navigator.clipboard` does not exist. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** A small "copy this message" icon; turns into a check mark for a moment. Fixed size, so nothing around it moves. */
export function CopyButton({ text, label = 'Copy message' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!text.trim()) return null;
  const click = async () => {
    setState((await copyText(text)) ? 'done' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  };
  return (
    <button type="button" className={styles.btn} data-state={state} onClick={() => void click()} title={state === 'failed' ? 'Could not copy' : state === 'done' ? 'Copied' : label} aria-label={label}>
      {state === 'done' ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : state === 'failed' ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <rect x="5.5" y="5.5" width="8" height="8.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 3.6V3.3A1.3 1.3 0 0 0 9.2 2H3.8A1.3 1.3 0 0 0 2.5 3.3v6.4A1.3 1.3 0 0 0 3.8 11H4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
