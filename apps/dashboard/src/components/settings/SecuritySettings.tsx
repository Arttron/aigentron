import { useState, type FormEvent } from 'react';
import { authApi } from '@/lib/auth';
import { useAuth } from '@/lib/auth-context';
import { Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';
import { SetPasswordForm, reconnectSocket } from '@/components/AuthGate';

/** Settings → General → Security: set the first password, or change YOUR password / sign out. */
export function SecuritySettings() {
  const { status, refresh } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const change = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return setMsg({ ok: false, text: 'The two new passwords differ.' });
    setBusy(true);
    const r = await authApi.changePassword(current, next).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setMsg({ ok: false, text: r?.data.error ?? 'Could not change the password.' });
    setCurrent('');
    setNext('');
    setAgain('');
    setMsg({ ok: true, text: 'Password changed. Your other browsers were signed out.' });
    reconnectSocket();
  };
  const signOut = async () => {
    await authApi.logout().catch(() => undefined);
    reconnectSocket();
    window.location.assign('/');
  };
  const everywhere = async () => {
    await authApi.signOutEverywhere().catch(() => undefined);
    setMsg({ ok: true, text: 'Every other browser was signed out (all users).' });
  };

  if (!status) return null;
  return (
    <Card>
      <SectionTitle>Security</SectionTitle>
      {!status.configured ? (
        <>
          <Muted>
            No password is set: anyone who can reach this address controls the platform. Set the first password (it becomes the
            default operator's) — then you can give every user their own in the <strong>Users</strong> tab. Agents on the server keep working.
          </Muted>
          <SetPasswordForm onDone={refresh} />
        </>
      ) : (
        <>
          <Muted>
            Signed in as <strong>{status.me?.displayName}</strong> ({status.me?.role}). You stay signed in on this browser for 30 days
            (AUTH_SESSION_DAYS). Other users' passwords are managed in the <strong>Users</strong> tab.
          </Muted>
          <form onSubmit={change} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            <Field label="Your current password">
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label="New password (at least 8 characters)">
              <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <Field label="Repeat the new password">
              <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </Field>
            <Row wrap>
              <Button type="submit" variant="primary" disabled={busy || !current || !next}>
                Change my password
              </Button>
              <Button onClick={everywhere}>Sign out other browsers</Button>
              <Button variant="red" onClick={signOut}>
                Sign out
              </Button>
            </Row>
          </form>
        </>
      )}
      {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
      <Muted>
        Forgot it? On the server run <code>make reset-password</code> (removes ALL passwords) and set the first one again.
      </Muted>
    </Card>
  );
}
