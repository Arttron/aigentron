import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type LoginStatus } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { Button, Muted, ErrorText, Row } from '@/components/ui';
import styles from './ProviderSignIn.module.css';

const ACTIVE = ['installing', 'starting', 'awaiting_browser', 'awaiting_code', 'finishing'];

/**
 * “Sign in” for a subscription provider (Codex / Claude): the server runs the provider's own sign-in, this shows the link, the
 * one-time code (or a box for the code the page returns) and the result. The credential never reaches the browser.
 */
export function ProviderSignIn({ name, onChanged, autoStart = false }: { name: string; onChanged?: () => void; autoStart?: boolean }) {
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const wasActive = useRef(false);

  const refresh = useCallback(() => {
    api
      .providerLogin(name)
      .then((s) => {
        setStatus(s);
        const active = Boolean(s.session && ACTIVE.includes(s.session.phase));
        if (wasActive.current && !active) onChanged?.();
        wasActive.current = active;
      })
      .catch((e: Error) => setError(e.message));
  }, [name, onChanged]);

  useEffect(refresh, [refresh]);
  // Just created: start at once (installs the CLI first when it is missing), so the person only has to sign in.
  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current || !status || !status.supported || status.loggedIn || status.session) return;
    started.current = true;
    api.providerLoginStart(name).then(refresh, (e: Error) => setError(e.message));
  }, [autoStart, status, name, refresh]);
  const session = status?.session ?? null;
  const active = Boolean(session && ACTIVE.includes(session.phase));
  usePolling(refresh, 1500, active);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!status) return error ? <ErrorText>{error}</ErrorText> : <Muted>Checking the sign-in…</Muted>;
  if (!status.supported) return null;

  const claude = status.flavor === 'claude';
  return (
    <div className={styles.box}>
      <Row>
        <span className={status.loggedIn ? styles.ok : styles.off}>{status.loggedIn ? '● Signed in' : '○ Not signed in'}</span>
        <Muted className={styles.grow}>
          {status.runtime && status.runtime.installed && status.runtime.version ? `CLI ${status.runtime.version} · ` : ''}
          {status.message}
        </Muted>
        {!active && (
          <Button variant="primary" onClick={() => run(() => api.providerLoginStart(name))} disabled={busy}>
            {status.loggedIn ? 'Sign in again' : 'Sign in'}
          </Button>
        )}
        {!active && status.loggedIn && (
          <Button onClick={() => window.confirm('Sign out of this provider? Agents using it will stop working until you sign in again.') && run(() => api.providerLogout(name))} disabled={busy}>
            Sign out
          </Button>
        )}
        {active && (
          <Button onClick={() => run(() => api.providerLoginCancel(name))} disabled={busy}>
            Cancel
          </Button>
        )}
      </Row>

      {session && (active || session.phase === 'failed') && (
        <div className={styles.steps}>
          <Muted>{session.phase === 'installing' ? `⏳ ${session.message}` : session.message}</Muted>
          {session.url && (
            <div className={styles.step}>
              <b>1.</b>{' '}
              <a href={session.url} target="_blank" rel="noreferrer">
                Open the sign-in page ↗
              </a>
              {claude ? ' and sign in with your Claude account.' : ' and sign in with your ChatGPT account.'}
            </div>
          )}
          {session.userCode && (
            <div className={styles.step}>
              <b>2.</b> Enter this code there: <code className={styles.code}>{session.userCode}</code>
            </div>
          )}
          {session.needsCode && (
            <div className={styles.step}>
              <b>2.</b> Paste the code the page shows
              <Row>
                <input
                  className={styles.grow}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="code from the page"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  variant="primary"
                  disabled={busy || !code.trim()}
                  onClick={() =>
                    run(async () => {
                      await api.providerLoginCode(name, code);
                      setCode('');
                    })
                  }
                >
                  Send
                </Button>
              </Row>
              <Muted className={styles.hint}>
                If your browser ends on a page that cannot be opened (<code>localhost:…/callback?code=…</code>), copy that whole address and paste it here instead.
              </Muted>
            </div>
          )}
        </div>
      )}
      {session?.phase === 'done' && <Muted>✓ {session.message}</Muted>}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
