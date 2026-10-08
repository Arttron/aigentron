import { useEffect, useRef, useState } from 'react';
import type { Mascot, StateName } from '@/lib/mascot';

/**
 * The admin mascot (one Lottie file, states as timeline segments — see lib/mascot.ts).
 * lottie-web and the animation are loaded lazily on first render so the dashboard's
 * initial bundle doesn't carry them; a static 💬 shows until the animation is ready (and
 * stays if it fails to load). Respects prefers-reduced-motion (shows the first frame).
 */
export function MascotView({ state, size = 56 }: { state: StateName; size?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<Mascot | null>(null);
  const wanted = useRef<StateName>(state);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      const [{ default: lottie }, { Mascot }, { default: data }] = await Promise.all([
        import('lottie-web/build/player/lottie_light'),
        import('@/lib/mascot'),
        import('@/assets/aigentron_admin_states.json'),
      ]);
      if (dead || !hostRef.current) return;
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const m = new Mascot(hostRef.current, data, lottie, { autoplay: !reduced });
      mascotRef.current = m;
      if (wanted.current !== 'idle') m.go(wanted.current, { urgent: wanted.current === 'success' || wanted.current === 'error' });
      setReady(true);
    })().catch(() => undefined); // keep the static fallback
    return () => {
      dead = true;
      mascotRef.current?.destroy();
      mascotRef.current = null;
    };
  }, []);

  useEffect(() => {
    wanted.current = state;
    // A finished reply / a failure should feel immediate, so one-shots crossfade in instead of waiting for the loop end.
    mascotRef.current?.go(state, { urgent: state === 'success' || state === 'error' });
  }, [state]);

  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'grid', placeItems: 'center' }} aria-hidden="true">
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {!ready && <span style={{ fontSize: Math.round(size * 0.45) }}>💬</span>}
    </div>
  );
}
