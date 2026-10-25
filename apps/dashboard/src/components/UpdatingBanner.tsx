import { useEffect, useState } from 'react';
import { API_BASE } from '@/lib/config';
import { UPDATING_EVENT } from '@/lib/auth';

/**
 * While the server updates, the update page of the installer answers every request with 503 and `x-aigentron-updating`. A tab that is already open
 * sees that on its next call (or the periodic refresh), says so, and reloads by itself once the real server answers again.
 */
export function UpdatingBanner() {
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    const on = () => setUpdating(true);
    window.addEventListener(UPDATING_EVENT, on);
    return () => window.removeEventListener(UPDATING_EVENT, on);
  }, []);

  useEffect(() => {
    if (!updating) return;
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
        if (r.ok && alive) window.location.reload(); // the new version answers
      } catch {
        /* still down: between the update page and the new server */
      }
    };
    const t = window.setInterval(() => void check(), 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [updating]);

  if (!updating) return null;
  return (
    <div role="status" style={{ position: 'sticky', top: 0, zIndex: 2000, padding: '10px 16px', textAlign: 'center', background: 'var(--amber-soft)', color: 'var(--text)', fontSize: 14, boxShadow: 'var(--raised-xs)' }}>
      ⏳ <strong>Aigentron is updating.</strong> The server is back in a minute or two — this page reloads by itself.
    </div>
  );
}
