import { useEffect, useState } from 'react';
import { Muted } from '@/components/ui';

/** Waits shorter than this are the normal hand-over between two runs, not worth a notice. */
const SHOW_AFTER_MS = 4000;

/** A queued task the server holds back (the machine is busy, or it waits its turn): says why, so the wait does not look like a hang. */
export function StartHoldNotice({ hold, queued }: { hold?: { reason: string; since: string; kind?: 'start' | 'command' } | null; queued: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hold?.since]);
  if (!hold || (!queued && hold.kind !== 'command')) return null;
  const waited = Math.max(0, now - new Date(hold.since).getTime());
  if (waited < SHOW_AFTER_MS) return null;
  const s = Math.round(waited / 1000);
  const waiting = s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
  if (hold.kind === 'command') {
    return (
      <Muted role="status">
        ⏳ The agent is waiting for the server: {hold.reason} — {waiting} so far. The command starts by itself when the machine has room.
      </Muted>
    );
  }
  return (
    <Muted role="status">
      ⏳ Queued, {hold.reason} — {s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`} so far. It starts by itself; no run waits longer than 10 minutes.
    </Muted>
  );
}
