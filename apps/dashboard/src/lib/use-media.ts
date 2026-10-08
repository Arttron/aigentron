import { useEffect, useState } from 'react';

/** Live `matchMedia` match (false where unsupported). Used to pick a layout, not to hide data. */
export function useMedia(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** A phone in either orientation: narrow portrait, or a short landscape viewport. */
export const useIsPhone = () => useMedia('(max-width: 640px), (max-height: 520px) and (orientation: landscape)');
/** Landscape phone: too little height for a docked message box with the keyboard open. */
export const useIsShort = () => useMedia('(max-height: 520px) and (orientation: landscape)');
