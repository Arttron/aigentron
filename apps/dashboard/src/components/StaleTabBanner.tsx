import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/lib/config';
import { isStale } from '@/lib/stale-tab';
import { Button } from '@/components/ui';
import styles from './ExtensionBanner.module.css';

const CHECK_EVERY_MS = 60_000;

async function serverVersion(): Promise<string | null> {
  try {
    const r = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
    if (!r.ok) return null;
    return ((await r.json()) as { version?: string }).version ?? null;
  } catch {
    return null; // the server is restarting (an update): look again later
  }
}

/** «Aigentron was updated — reload this page»: a tab that was open during an update still runs the old code (an old bug can seem not fixed until it is reloaded). */
export function StaleTabBanner() {
  const loaded = useRef<string | null>(null);
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const look = async () => {
      const v = await serverVersion();
      if (!alive || !v) return;
      if (loaded.current === null) loaded.current = v; // the version this page started with
      else if (isStale(loaded.current, v)) setNow(v);
    };
    void look();
    const t = window.setInterval(() => void look(), CHECK_EVERY_MS);
    // a tab that comes back to the front is looked at at once
    const onVisible = () => document.visibilityState === 'visible' && void look();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  if (!now) return null;
  return (
    <div className={styles.wrap}>
      <div className={styles.banner} role="status">
        <span>
          Aigentron was updated (now <strong>{now}</strong>). This page is still running the old version — reload it to get the fixes.
        </span>
        <Button size="sm" variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  );
}
