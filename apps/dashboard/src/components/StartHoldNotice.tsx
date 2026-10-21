import { useEffect, useState } from 'react';
import { Muted } from '@/components/ui';

/** Waits shorter than this are the normal hand-over between two runs, not worth a notice. */
const SHOW_AFTER_MS = 4000;

/** A queued task the server holds back (the machine is busy, or it waits its turn): says why, so the wait does not look like a hang. */
export function StartHoldNotice({ hold, queued }: { hold?: { reason: string; since: string } | null; queued: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hold?.since]);
  if (!queued || !hold) return null;
  const waited = Math.max(0, now - new Date(hold.since).getTime());
  if (waited < SHOW_AFTER_MS) return null;
  const s = Math.round(waited / 1000);
  return (
    <Muted role="status">
      ⏳ Queued, {hold.reason} — {s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`} so far. It starts by itself; no run waits longer than 10 minutes.
    </Muted>
  );
}
