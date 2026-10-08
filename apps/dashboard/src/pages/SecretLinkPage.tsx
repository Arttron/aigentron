import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { API_BASE } from '@/lib/config';
import { Button, Card, ErrorText, Field, Muted, Row } from '@/components/ui';
import styles from '@/components/AuthGate.module.css';

/**
 * The page behind a one-time "enter a secret" link (opened from a Telegram message on a phone). No sign-in: the link's
 * token is the credential, it can only fill the ONE value that a pending request asks for, and it works once.
 */
export function SecretLinkPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [info, setInfo] = useState<{ label: string; reason: string; expiresInSec: number } | null>(null);
  const [value, setValue] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saved' | 'dead'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch(`${API_BASE}/secret-links/${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { label?: string; reason?: string; expiresInSec?: number; message?: string };
        if (!r.ok) {
          setError(j.message ?? 'This link is not valid.');
          setState('dead');
          return;
        }
        setInfo({ label: j.label ?? 'a secret', reason: j.reason ?? '', expiresInSec: j.expiresInSec ?? 0 });
        setState('ready');
      })
      .catch(() => {
        setError('Could not reach the server.');
        setState('dead');
      });
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch(`${API_BASE}/secret-links/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    }).catch(() => null);
    setBusy(false);
    if (r?.ok) {
      setValue('');
      return setState('saved');
    }
    const j = (await r?.json().catch(() => ({}))) as { message?: string | string[] };
    setError(Array.isArray(j.message) ? j.message.join('; ') : (j.message ?? 'Could not save.'));
  };

  return (
    <div className={styles.center}>
      <Card>
        <h1 className={styles.title}>🔐 Enter a secret</h1>
        {state === 'loading' && <Muted>Checking the link…</Muted>}
        {state === 'dead' && <ErrorText>{error}</ErrorText>}
        {state === 'saved' && <Muted>✅ Saved. The value went straight to the server — the assistant never sees it. You can close this page and go back to the chat.</Muted>}
        {state === 'ready' && info && (
          <form onSubmit={submit} className={styles.form}>
            <Muted>
              The assistant asks for: <strong>{info.label}</strong>
              {info.reason ? ` — ${info.reason}` : ''}. This link works once and expires in about {Math.max(1, Math.round(info.expiresInSec / 60))} min.
            </Muted>
            <Field label="Key / token">
              <input type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            </Field>
            {error && <ErrorText>{error}</ErrorText>}
            <Row>
              <Button type="submit" variant="primary" disabled={busy || !value.trim()}>
                Save
              </Button>
            </Row>
          </form>
        )}
      </Card>
    </div>
  );
}
