import { useEffect, useRef } from 'react';

/**
 * Calls `fn` every `ms` while the tab is visible (and `enabled`). A hidden tab stops polling;
 * when it becomes visible again `fn` runs once immediately, then the interval resumes.
 * `fn` may change between renders without restarting the timer.
 */
export function usePolling(fn: () => void, ms: number, enabled = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer === undefined) timer = setInterval(() => ref.current(), ms);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') stop();
      else {
        ref.current();
        start();
      }
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ms, enabled]);
}
