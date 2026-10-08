import { useEffect, useState } from 'react';

/**
 * Per-browser view preferences for the conversation: `terminal` (monospace, prompt-style, adapts to the light/dark
 * theme) or `classic`; and `all` (with tool calls) or `messages` (conversation only). Purely client-side.
 */
export type Look = 'terminal' | 'classic';
export type Show = 'all' | 'messages';

const KEY = { look: 'lds-chat-look', show: 'lds-chat-show' } as const;
const EVENT = 'lds-chat-pref';

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function usePref<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, allowed, fallback));
  useEffect(() => {
    const sync = () => setValue(read(key, allowed, fallback));
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [key]);
  const set = (v: T) => {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* not persisted */
    }
    setValue(v);
    window.dispatchEvent(new Event(EVENT));
  };
  return [value, set];
}

export const useLook = () => usePref<Look>(KEY.look, ['terminal', 'classic'], 'terminal');
export const useShow = () => usePref<Show>(KEY.show, ['all', 'messages'], 'all');
