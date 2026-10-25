import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/lib/config';
import { Button, Card, ErrorText, Muted, Row, SectionTitle } from '@/components/ui';

interface UpdateStatus {
  current: string;
  latest: string | null;
  newer: boolean;
  notes: string;
  url: string;
  publishedAt: string | null;
  checkedAt: string;
  checkError: string | null;
  environment: { canApply: boolean; kind: string; reason: string | null };
  runningTasks: number;
  last: { state: 'running' | 'ok' | 'failed'; version: string; startedAt: string; finishedAt: string; error: string; logTail: string; logAt?: string | null } | null;
}

/** `125000` ms → `2 min` / `45 s`. */
const mins = (ms: number): string => (Number.isFinite(ms) && ms >= 0 ? (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.max(0, Math.round(ms / 1000))} s`) : 'a while');

/** Settings → General → Version & updates: see what is new and update the server (an operator confirms; the server restarts). */
export function UpdateSettings() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null); // the version being installed
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'done'>('idle');
  const timer = useRef<number | null>(null);
  // An update that the SERVER says is running (started from this page, another tab, the admin or the console): the truth is its status file, not this tab's memory.
  const running = st?.last?.state === 'running' ? st.last : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const load = useCallback(async (force = false) => {
    const r = await fetch(`${API_BASE}/update${force ? '/check' : ''}`, { method: force ? 'POST' : 'GET', cache: 'no-store' }).catch(() => null);
    if (r?.ok) setSt((await r.json()) as UpdateStatus);
    return r?.ok ?? false;
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // while an update runs the server goes away and comes back: poll until it reports the new version (also for an update started elsewhere)
  useEffect(() => {
    if (!running && (!target || phase === 'done')) return;
    timer.current = window.setInterval(async () => {
      const r = await fetch(`${API_BASE}/update`, { cache: 'no-store' }).catch(() => null);
      if (!r?.ok) return setPhase('restarting');
      const s = (await r.json()) as UpdateStatus;
      setSt(s);
      const goal = target ?? running?.version ?? null;
      if (goal && s.current === goal && s.last?.state !== 'running') {
        setPhase('done');
        window.setTimeout(() => window.location.reload(), 2500);
      } else if (s.last?.state === 'failed') {
        setTarget(null);
        setPhase('idle');
      } else if (s.last?.state === 'running') setPhase('restarting');
      else if (target) setPhase('restarting');
    }, 3000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [target, phase, running]);

  const apply = async () => {
    if (!st?.latest) return;
    const running = st.runningTasks;
    if (running) return;
    if (!window.confirm(`Update the server from ${st.current} to ${st.latest}?\n\nThe server restarts for a minute or two — the dashboard and chats are unreachable meanwhile.${running ? `\n\n${running} running or queued task(s) will be interrupted.` : ''}\n\nThe previous version is kept for a rollback.`)) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`${API_BASE}/update/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: st.latest, force: running > 0 }),
    }).catch(() => null);
    const j = (await r?.json().catch(() => ({}))) as { message?: string | string[] };
    setBusy(false);
    if (!r?.ok) {
      void load(); // "already running": show that update (its progress) instead of just the error
      return setErr(Array.isArray(j.message) ? j.message.join('; ') : (j.message ?? 'Could not start the update.'));
    }
    setTarget(st.latest);
    setPhase('restarting');
  };

  if (!st) return null;
  return (
    <Card>
      <SectionTitle>Version &amp; updates</SectionTitle>
      <Muted>
        Installed: <strong>{st.current}</strong>
        {st.latest ? (
          <>
            {' · '}newest release: <strong>{st.latest}</strong>
            {running ? ` — ${running.version} is being installed` : st.newer ? ' — an update is available' : ' — up to date'}
            {st.publishedAt ? ` (${st.publishedAt.slice(0, 10)})` : ''}
          </>
        ) : (
          <> · could not check for updates{st.checkError ? ` (${st.checkError})` : ''}</>
        )}
      </Muted>

      {running && phase !== 'done' && (
        <>
          <Muted role="status">
            ⏳ <strong>Updating to {running.version}</strong> — started {mins(now - Date.parse(running.startedAt))} ago. The server goes down for a while as it switches versions (2–4 minutes on a small server;
            the first minutes are spent preparing the new release while this one keeps working). Do not restart it by hand; this page keeps checking and reloads by itself.
          </Muted>
          {running.logAt && now - Date.parse(running.logAt) > 5 * 60_000 && (
            <ErrorText>
              Nothing has been written to the update log for {mins(now - Date.parse(running.logAt))} — the update may be stuck. Look at the log below, or on the server:{' '}
              <code>sudo journalctl -u aigentron -n 80</code>. If it is stuck, <code>sudo aigentron rollback</code> brings the previous version back.
            </ErrorText>
          )}
          {running.logTail && (
            <details>
              <summary>What the installer is doing</summary>
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', fontSize: 12 }}>{running.logTail.split('\n').slice(-14).join('\n')}</pre>
            </details>
          )}
        </>
      )}

      {phase !== 'idle' && target && !running && (
        <Muted>
          {phase === 'done' ? `✓ Updated to ${target} — reloading…` : `⏳ Updating to ${target}. The server is down while it switches versions and restarts — 2–4 minutes on a small server. Do not restart it by hand; this page reconnects by itself.`}
        </Muted>
      )}

      {st.newer && st.notes && phase === 'idle' && !running && (
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', margin: '10px 0', fontSize: 12.5 }}>{st.notes}</pre>
      )}

      {st.newer && phase === 'idle' && !running && !st.environment.canApply && (
        <Muted>
          ⓘ {st.environment.reason} {st.environment.kind === 'docker' || st.environment.kind === 'bare-metal' ? <>On the server: <code>sudo aigentron update</code>.</> : null}
        </Muted>
      )}

      <Row wrap style={{ marginTop: 12 }}>
        {st.newer && phase === 'idle' && !running && st.environment.canApply && (
          <Button variant="primary" disabled={busy} onClick={apply}>
            Update to {st.latest}
          </Button>
        )}
        <Button disabled={busy || phase !== 'idle' || !!running} onClick={() => void load(true)}>
          Check now
        </Button>
        {st.url && (
          <a href={st.url} target="_blank" rel="noreferrer">
            Release notes ↗
          </a>
        )}
      </Row>
      {st.newer && phase === 'idle' && !running && st.environment.canApply && st.runningTasks > 0 && (
        <Muted>{st.runningTasks} task(s) running — they would be interrupted.</Muted>
      )}
      {err && <ErrorText>{err}</ErrorText>}
      {st.last?.state === 'failed' && (
        <ErrorText>
          The last update (to {st.last.version}) failed — the previous version is still running. Log: <code>{st.last.error}</code>
        </ErrorText>
      )}
      {st.last?.state === 'failed' && st.last.logTail && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontSize: 12 }}>{st.last.logTail}</pre>}
      <Muted>
        An update installs the new release next to the current one and restarts the server (about a minute or two). Your data, settings and passwords are kept, and the previous
        version stays for a rollback: <code>sudo aigentron rollback</code> on the server.
      </Muted>
    </Card>
  );
}
