import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '@/lib/config';
import { Badge, Button, Card, ErrorText, Muted, Row, SectionTitle } from '@/components/ui';

interface SessionRow {
  id: string;
  userId: string;
  userName: string;
  role: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
};

/** Settings → Security → Signed-in devices: your sessions; an operator/admin also sees (and can end) everybody's. */
export function SessionsSettings() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [me, setMe] = useState<{ id: string; role: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`${API_BASE}/auth/sessions`, { cache: 'no-store' }).catch(() => null);
    if (r?.ok) setRows((await r.json()) as SessionRow[]);
    const st = await fetch(`${API_BASE}/auth/status`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (st?.me) setMe({ id: st.me.id, role: st.me.role });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const call = async (path: string, method: string, confirmText?: string, leaves?: boolean) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`${API_BASE}${path}`, { method }).catch(() => null);
    const j = (await r?.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r?.ok) return setErr(j.error ?? 'Could not do that.');
    if (leaves) window.location.reload(); // you ended your own current session
    else await load();
  };

  if (!rows) return null;
  if (rows.length === 0) {
    return (
      <Card>
        <SectionTitle>Signed-in devices</SectionTitle>
        <Muted>
          Nothing to show yet. Devices appear here once sign-in is on (Settings → Security) and someone signs in. Sessions that were already signed in before this list existed keep
          working but are not shown.
        </Muted>
      </Card>
    );
  }
  const manager = me?.role === 'operator' || me?.role === 'admin';
  const users = [...new Map(rows.map((r) => [r.userId, r.userName])).entries()];

  return (
    <Card>
      <SectionTitle>Signed-in devices</SectionTitle>
      <Muted>
        Every browser or device that is signed in {manager ? '— yours and everybody else’s' : 'as you'}. Ending a session signs that device out at once. Changing a password ends all of that
        person&rsquo;s sessions.
      </Muted>
      {users.map(([uid, name]) => {
        const mine = rows.filter((r) => r.userId === uid);
        return (
          <div key={uid} style={{ margin: '14px 0' }}>
            <Row spaceBetween wrap>
              <strong>
                {name}
                {uid === me?.id ? ' (you)' : ''} <Muted>{mine[0]?.role}</Muted>
              </strong>
              {uid === me?.id ? (
                <Button size="sm" disabled={busy || mine.length < 2} onClick={() => call('/auth/sessions/revoke-others', 'POST', 'Sign out all your other devices? This browser stays signed in.')}>
                  Sign out my other devices
                </Button>
              ) : (
                manager && (
                  <Button size="sm" variant="red" disabled={busy} onClick={() => call(`/auth/users/${uid}/sessions`, 'DELETE', `Sign ${name} out on every device? Their password stays.`)}>
                    Sign {name} out everywhere
                  </Button>
                )
              )}
            </Row>
            <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
              {mine.map((s) => (
                <li key={s.id} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', alignItems: 'center', padding: '6px 0', borderTop: '1px solid rgba(127,127,127,.18)' }}>
                  <span style={{ minWidth: 150 }}>
                    <strong>{s.device}</strong> {s.current && <Badge tone="running">this device</Badge>}
                  </span>
                  <Muted>{s.ip ?? 'unknown address'}</Muted>
                  <Muted>signed in {ago(s.createdAt)}</Muted>
                  <Muted>last active {ago(s.lastSeenAt)}</Muted>
                  <span style={{ flex: 1 }} />
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => call(`/auth/sessions/${s.id}`, 'DELETE', s.current ? 'Sign out of this browser?' : `Sign out ${s.device}${s.ip ? ` (${s.ip})` : ''}?`, s.current)}
                  >
                    Sign out
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {err && <ErrorText>{err}</ErrorText>}
    </Card>
  );
}
