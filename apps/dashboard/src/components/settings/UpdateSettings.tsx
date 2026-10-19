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
  last: { state: 'running' | 'ok' | 'failed'; version: string; startedAt: string; finishedAt: string; error: string; logTail: string } | null;
}

/** Settings → General → Version & updates: see what is new and update the server (an operator confirms; the server restarts). */
export function UpdateSettings() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null); // the version being installed
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'done'>('idle');
  const timer = useRef<number | null>(null);

  const load = useCallback(async (force = false) => {
    const r = await fetch(`${API_BASE}/update${force ? '/check' : ''}`, { method: force ? 'POST' : 'GET', cache: 'no-store' }).catch(() => null);
    if (r?.ok) setSt((await r.json()) as UpdateStatus);
    return r?.ok ?? false;
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // while an update runs the server goes away and comes back: poll until it reports the new version
  useEffect(() => {
    if (!target || phase === 'done') return;
    timer.current = window.setInterval(async () => {
      const r = await fetch(`${API_BASE}/update`, { cache: 'no-store' }).catch(() => null);
      if (!r?.ok) return setPhase('restarting');
      const s = (await r.json()) as UpdateStatus;
      setSt(s);
      if (s.current === target) {
        setPhase('done');
        window.setTimeout(() => window.location.reload(), 2500);
      } else if (s.last?.state === 'failed') {
        setTarget(null);
        setPhase('idle');
      } else setPhase('restarting');
    }, 3000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [target, phase]);

  const apply = async () => {
    if (!st?.latest) return;
    const running = st.runningTasks;
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
    if (!r?.ok) return setErr(Array.isArray(j.message) ? j.message.join('; ') : (j.message ?? 'Could not start the update.'));
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
            {st.newer ? ' — an update is available' : ' — up to date'}
            {st.publishedAt ? ` (${st.publishedAt.slice(0, 10)})` : ''}
          </>
        ) : (
          <> · could not check for updates{st.checkError ? ` (${st.checkError})` : ''}</>
        )}
      </Muted>

      {phase !== 'idle' && target && (
        <Muted>
          {phase === 'done' ? `✓ Updated to ${target} — reloading…` : `⏳ Updating to ${target}. The server is down while it switches versions and restarts — 2–4 minutes on a small server. Do not restart it by hand; this page reconnects by itself.`}
        </Muted>
      )}

      {st.newer && st.notes && phase === 'idle' && (
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', margin: '10px 0', fontSize: 12.5 }}>{st.notes}</pre>
      )}

      {st.newer && phase === 'idle' && !st.environment.canApply && (
        <Muted>
          ⓘ {st.environment.reason} {st.environment.kind === 'docker' || st.environment.kind === 'bare-metal' ? <>On the server: <code>sudo aigentron update</code>.</> : null}
        </Muted>
      )}

      <Row wrap style={{ marginTop: 12 }}>
        {st.newer && phase === 'idle' && st.environment.canApply && (
          <Button variant="primary" disabled={busy} onClick={apply}>
            Update to {st.latest}
          </Button>
        )}
        <Button disabled={busy || phase !== 'idle'} onClick={() => void load(true)}>
          Check now
        </Button>
        {st.url && (
          <a href={st.url} target="_blank" rel="noreferrer">
            Release notes ↗
          </a>
        )}
      </Row>
      {st.newer && phase === 'idle' && st.environment.canApply && st.runningTasks > 0 && (
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
