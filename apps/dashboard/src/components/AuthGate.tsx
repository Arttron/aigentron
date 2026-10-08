import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AUTH_REQUIRED_EVENT, authApi, type AuthStatus, type LoginUser } from '@/lib/auth';
import { AuthContext } from '@/lib/auth-context';
import { getSocket } from '@/lib/socket';
import { Button, Card, ErrorText, Field, Modal, Muted, Row } from '@/components/ui';
import styles from './AuthGate.module.css';

/** Reconnect the live-updates socket so it carries the (new or cleared) session cookie. */
export function reconnectSocket(): void {
  const s = getSocket();
  s.disconnect();
  s.connect();
}

/** Set-a-password form, used by the banner and by Settings → Security. */
export function SetPasswordForm({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== again) return setError('The two passwords differ.');
    setBusy(true);
    setError(null);
    const r = await authApi.setup(pw).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setError(r?.data.error ?? 'Could not set the password.');
    reconnectSocket();
    onDone();
  };
  return (
    <form onSubmit={submit} className={styles.form}>
      <Field label="New password (at least 8 characters)">
        <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      </Field>
      <Field label="Repeat the password">
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      {error && <ErrorText>{error}</ErrorText>}
      <Row>
        <Button type="submit" variant="primary" disabled={busy || !pw}>
          Set password
        </Button>
      </Row>
    </form>
  );
}

const LAST_USER_KEY = 'lds.lastLoginUser';

function LoginScreen({ users, onDone }: { users: LoginUser[]; onDone: () => void }) {
  const remembered = (() => {
    try {
      return window.localStorage.getItem(LAST_USER_KEY);
    } catch {
      return null;
    }
  })();
  const [uid, setUid] = useState<string>(users.find((u) => u.id === remembered)?.id ?? (users.length === 1 ? users[0]!.id : ''));
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await authApi.login(uid, pw).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setError(r?.data.error ?? 'Could not reach the server.');
    try {
      window.localStorage.setItem(LAST_USER_KEY, uid);
    } catch {
      /* not remembered */
    }
    reconnectSocket();
    onDone();
  };
  return (
    <div className={styles.center}>
      <Card>
        <h1 className={styles.title}>🤖 Agent Fleet</h1>
        <Muted>Who is signing in?</Muted>
        <div className={styles.users} role="radiogroup" aria-label="User">
          {users.map((u) => (
            <button
              key={u.id}
              type="button"
              role="radio"
              aria-checked={uid === u.id}
              className={uid === u.id ? styles.userOn : styles.user}
              onClick={() => {
                setUid(u.id);
                setError(null);
              }}
            >
              <span>{u.displayName}</span>
              <span className={styles.role}>{u.role}</span>
            </button>
          ))}
        </div>
        <form onSubmit={submit} className={styles.form}>
          <Field label="Password">
            <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus={!!uid} />
          </Field>
          {error && <ErrorText>{error}</ErrorText>}
          <Row>
            <Button type="submit" variant="primary" disabled={busy || !pw || !uid}>
              Sign in
            </Button>
          </Row>
        </form>
      </Card>
    </div>
  );
}

/**
 * Wraps the app. With a password set and no valid session it shows the sign-in screen instead of the app; without a
 * password everything works as before but a banner asks to set one.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [setting, setSetting] = useState(false);

  const refresh = useCallback(() => {
    authApi
      .status()
      .then(setStatus)
      .catch(() => setStatus((s) => s ?? { configured: false, authenticated: true, publicUrl: false, users: [], me: null }));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(AUTH_REQUIRED_EVENT, refresh);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, refresh);
  }, [refresh]);

  if (!status) return null;
  if (status.configured && !status.authenticated) return <LoginScreen users={status.users} onDone={refresh} />;

  return (
    <AuthContext.Provider value={{ status, refresh }}>
      {!status.configured && !dismissed && (
        <div className={status.publicUrl ? styles.bannerWarn : styles.banner} role="status">
          <span>
            {status.publicUrl
              ? 'This dashboard is reachable from the internet and has NO password. '
              : 'No password is set — anyone who can open this page controls the platform. '}
          </span>
          <Button size="sm" variant="primary" onClick={() => setSetting(true)}>
            Set password
          </Button>
          {!status.publicUrl && (
            <button type="button" className={styles.dismiss} onClick={() => setDismissed(true)} aria-label="Dismiss">
              ✕
            </button>
          )}
        </div>
      )}
      {setting && (
        <Modal title="Set a password" onClose={() => setSetting(false)}>
          <Muted>One password protects the dashboard and the API. You stay signed in on this browser for 30 days.</Muted>
          <SetPasswordForm
            onDone={() => {
              setSetting(false);
              refresh();
            }}
          />
        </Modal>
      )}
      {children}
    </AuthContext.Provider>
  );
}
