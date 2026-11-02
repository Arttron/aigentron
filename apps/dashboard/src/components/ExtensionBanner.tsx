import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { connectExtension, extensionOutdated, useExtension } from '@/lib/extension-bridge';
import { Button } from '@/components/ui';
import styles from './ExtensionBanner.module.css';

const KEY = 'lds.extensionBannerDismissed';

/** «The Aigentron extension is installed — Connect»: shown while the extension is on this page but not connected (or signed out). */
export function ExtensionBanner() {
  const ext = useExtension();
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  const [shipped, setShipped] = useState<string | undefined>();
  useEffect(() => {
    if (ext.detected && ext.connected) void api.extensionInfo().then((i) => setShipped(i.extensionVersion)).catch(() => undefined);
  }, [ext.detected, ext.connected]);
  if (ext.detected && ext.connected && !hidden && extensionOutdated(ext.version, shipped)) {
    return (
      <div className={styles.banner} role="status">
        <span>A newer Aigentron extension is available ({ext.version} → {shipped}): click its icon → <strong>Update the extension</strong>.</span>
        <button type="button" className={styles.close} onClick={() => { setHidden(true); try { sessionStorage.setItem(KEY, '1'); } catch { /* not persisted */ } }} aria-label="Dismiss">×</button>
      </div>
    );
  }
  if (!ext.detected || ext.connected || hidden) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      /* not persisted */
    }
  };
  return (
    <div className={styles.banner} role="status">
      <span>{ext.needsReconnect ? 'The Aigentron browser extension was signed out. ' : 'The Aigentron browser extension is installed. '}</span>
      <Button size="sm" variant="primary" disabled={ext.busy} onClick={() => void connectExtension()}>
        {ext.busy ? 'Connecting…' : ext.needsReconnect ? 'Reconnect' : 'Connect'}
      </Button>
      <button type="button" className={styles.close} onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
      {ext.error && <span className={styles.error}> {ext.error}</span>}
    </div>
  );
}
