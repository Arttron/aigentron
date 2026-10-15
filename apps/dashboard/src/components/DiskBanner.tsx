import { useEffect, useState } from 'react';
import { usePolling } from '@/lib/use-polling';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format-bytes';
import styles from './AuthGate.module.css';

type Disk = Awaited<ReturnType<typeof api.diskStatus>>;

/** A warning across the top when the server's disk is running out (managers only; checked every minute). */
export function DiskBanner() {
  const [disk, setDisk] = useState<Disk>(null);
  const [hiddenFor, setHiddenFor] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('lds.diskDismissed');
    } catch {
      return null;
    }
  });

  const poll = () =>
    void api
      .diskStatus()
      .then(setDisk)
      .catch(() => undefined); // a person without the manager role simply sees nothing
  useEffect(poll, []);
  usePolling(poll, 60_000);

  if (!disk || disk.level === 'ok' || hiddenFor === disk.level) return null; // dismissing "warn" does not hide a later "critical"
  const critical = disk.level === 'critical';
  return (
    <div className={critical ? styles.bannerWarn : styles.banner} role="status">
      <span>
        {critical ? '🛑 Disk space is critically low' : '⚠️ Disk space is running low'}: {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}.
        {critical && disk.relief ? ` Caches were cleared automatically (${formatBytes(disk.relief.bytes)}).` : ''}
      </span>
      <a href="/settings">Free up space →</a>
      <button
        type="button"
        className={styles.dismiss}
        aria-label="Dismiss"
        onClick={() => {
          setHiddenFor(disk.level);
          try {
            sessionStorage.setItem('lds.diskDismissed', disk.level);
          } catch {
            /* not remembered */
          }
        }}
      >
        ✕
      </button>
    </div>
  );
}
