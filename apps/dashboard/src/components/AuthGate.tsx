import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AUTH_REQUIRED_EVENT, authApi, type AuthStatus, type LoginUser } from '@/lib/auth';
import { AuthContext } from '@/lib/auth-context';
import { getSocket } from '@/lib/socket';
import { DiskBanner } from '@/components/DiskBanner';
import { Button, Card, ErrorText, Field, Modal, Muted, Row } from '@/components/ui';
import { Qr } from '@/components/QrCode';
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
        <input
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
        />
      </Field>
      <Field label="Repeat the password">
        <input
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
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
  const [uid, setUid] = useState<string>(
    users.find((u) => u.id === remembered)?.id ?? (users.length === 1 ? users[0]!.id : ''),
  );
  const [pw, setPw] = useState('');
  // the second step: the password was right and this account has two-factor sign-in on
  const [needsCode, setNeedsCode] = useState(false);
  // required but not set up yet: the QR to scan; and, after the first code, the recovery codes (shown once, before the app opens)
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await authApi.login(uid, pw, needsCode ? code : undefined).catch(() => null);
    setBusy(false);
    if (r?.data.needsSetup) {
      if (setup) setError(r.data.error ?? 'Wrong code.'); // the first offer is not an error; a wrong code is
      setSetup(r.data.needsSetup);
      setNeedsCode(true);
      setCode('');
      return;
    }
    if (r?.data.needsCode) {
      // the first ask is not an error; a wrong code is
      if (needsCode) setError(r.data.error ?? 'Wrong code.');
      setNeedsCode(true);
      setCode('');
      return;
    }
    if (!r?.ok) return setError(r?.data.error ?? 'Could not reach the server.');
    try {
      window.localStorage.setItem(LAST_USER_KEY, uid);
    } catch {
      /* not remembered */
    }
    reconnectSocket();
    if (r.data.recoveryCodes?.length) return setSaved(r.data.recoveryCodes); // onDone after they are saved
    onDone();
  };
  if (saved) {
    return (
      <div className={styles.center}>
        <Card>
          <h1 className={styles.title}>Two-factor sign-in is on</h1>
          <Muted>
            <strong>Save these recovery codes now</strong> — they are shown only once. Each works
            one time if you lose your phone (type one instead of the code).
          </Muted>
          <pre
            style={{
              margin: '12px 0',
              padding: 10,
              borderRadius: 8,
              background: 'var(--bg-elev-2)',
              userSelect: 'all',
            }}
          >
            {saved.join('\n')}
          </pre>
          <Row>
            <Button
              onClick={() =>
                void navigator.clipboard?.writeText(saved.join('\n')).catch(() => undefined)
              }
            >
              Copy
            </Button>
            <Button variant="primary" onClick={onDone}>
              I saved them
            </Button>
          </Row>
        </Card>
      </div>
    );
  }
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
                setNeedsCode(false);
                setSetup(null);
                setError(null);
              }}
            >
              <span>{u.displayName}</span>
              <span className={styles.role}>{u.role}</span>
            </button>
          ))}
        </div>
        <form onSubmit={submit} className={styles.form}>
          {!needsCode ? (
            <Field label="Password">
              <input
                type="password"
                autoComplete="current-password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoFocus={!!uid}
              />
            </Field>
          ) : (
            <>
              {setup && (
                <>
                  <Muted>
                    Your administrator requires two-factor sign-in. Scan this with an authenticator
                    app (Google / Microsoft Authenticator, 1Password, Aegis …), then type the code
                    it shows.
                  </Muted>
                  <Qr text={setup.uri} />
                  <Muted>
                    <a href={setup.uri}>Open in the authenticator app</a> · key:{' '}
                    <code style={{ wordBreak: 'break-all' }}>{setup.secret}</code>
                  </Muted>
                </>
              )}
              <Field
                label={setup ? 'Code' : 'Code from your authenticator app (or a recovery code)'}
              >
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="123456"
                  autoFocus
                />
              </Field>
            </>
          )}
          {error && <ErrorText>{error}</ErrorText>}
          <Row>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !uid || (needsCode ? !code.trim() : !pw)}
            >
              {needsCode ? 'Verify' : 'Sign in'}
            </Button>
            {needsCode && (
              <Button
                type="button"
                onClick={() => {
                  setNeedsCode(false);
                  setSetup(null);
                  setCode('');
                  setPw('');
                  setError(null);
                }}
              >
                Back
              </Button>
            )}
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
      .catch(() =>
        setStatus(
          (s) =>
            s ?? { configured: false, authenticated: true, publicUrl: false, users: [], me: null },
        ),
      );
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(AUTH_REQUIRED_EVENT, refresh);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, refresh);
  }, [refresh]);

  if (!status) return null;
  if (status.configured && !status.authenticated)
    return <LoginScreen users={status.users} onDone={refresh} />;

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
            <button
              type="button"
              className={styles.dismiss}
              onClick={() => setDismissed(true)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      )}
      <DiskBanner />
      {setting && (
        <Modal title="Set a password" onClose={() => setSetting(false)}>
          <Muted>
            One password protects the dashboard and the API. You stay signed in on this browser for
            30 days.
          </Muted>
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
