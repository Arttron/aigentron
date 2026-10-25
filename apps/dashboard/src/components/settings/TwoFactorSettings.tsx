import { useState, type FormEvent } from 'react';
import { twoFactorApi } from '@/lib/auth';
import { useAuth } from '@/lib/auth-context';
import { Button, ErrorText, Field, Muted, Row } from '@/components/ui';
import { Qr } from '@/components/QrCode';

/** Settings → Security: sign in with a code from an authenticator app (TOTP) in addition to the password. */
export function TwoFactorSettings() {
  const { status, refresh } = useAuth();
  const on = !!status?.twoFactor?.enabled;
  const [mode, setMode] = useState<'idle' | 'password' | 'scan' | 'codes' | 'disable' | 'regen'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode('idle');
    setPassword('');
    setCode('');
    setSetup(null);
    setError(null);
  };
  const run = async (fn: () => Promise<{ ok: boolean; data: { error?: string } }>, done: (data: never) => void) => {
    setBusy(true);
    setError(null);
    const r = await fn().catch(() => null);
    setBusy(false);
    if (!r?.ok) return setError(r?.data.error ?? 'Could not reach the server.');
    done(r.data as never);
  };

  const begin = (e: FormEvent) => {
    e.preventDefault();
    void run(() => twoFactorApi.begin(password), ((d: { secret: string; uri: string }) => {
      setSetup(d);
      setPassword('');
      setMode('scan');
    }) as never);
  };
  const enable = (e: FormEvent) => {
    e.preventDefault();
    void run(() => twoFactorApi.enable(code), ((d: { recoveryCodes: string[] }) => {
      setCodes(d.recoveryCodes);
      setCode('');
      setSetup(null);
      setMode('codes');
      refresh();
    }) as never);
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    void run(() => twoFactorApi.disable(password, code), (() => {
      reset();
      refresh();
    }) as never);
  };
  const regen = (e: FormEvent) => {
    e.preventDefault();
    void run(() => twoFactorApi.recoveryCodes(password, code), ((d: { recoveryCodes: string[] }) => {
      setCodes(d.recoveryCodes);
      setPassword('');
      setCode('');
      setMode('codes');
      refresh();
    }) as never);
  };

  const form = { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 } as const;
  const codeField = (label: string) => (
    <Field label={label}>
      <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoCapitalize="off" spellCheck={false} placeholder="123456" />
    </Field>
  );

  return (
    <div style={{ marginTop: 20 }}>
      <strong>Two-factor sign-in</strong>
      {mode === 'idle' && (
        <>
          <Muted>
            {on
              ? `On: signing in needs the password and a 6-digit code from your authenticator app. ${status?.twoFactor?.recoveryLeft ?? 0} recovery code(s) left.${status?.twoFactor?.required ? ' An administrator requires it for your account.' : ''}`
              : 'Off. Turn it on so that a stolen password alone is not enough: you also type a 6-digit code from an app such as Google Authenticator, Microsoft Authenticator, 1Password or Aegis.'}
          </Muted>
          <Row wrap>
            {on ? (
              <>
                <Button onClick={() => setMode('regen')}>New recovery codes</Button>
                {!status?.twoFactor?.required && (
                  <Button variant="red" onClick={() => setMode('disable')}>
                    Turn off
                  </Button>
                )}
              </>
            ) : (
              <Button variant="primary" onClick={() => setMode('password')}>
                Turn on
              </Button>
            )}
          </Row>
        </>
      )}

      {mode === 'password' && (
        <form onSubmit={begin} style={form}>
          <Muted>Confirm it is you.</Muted>
          <Field label="Your password">
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
          <Row wrap>
            <Button type="submit" variant="primary" disabled={busy || !password}>
              Continue
            </Button>
            <Button type="button" onClick={reset}>
              Cancel
            </Button>
          </Row>
        </form>
      )}

      {mode === 'scan' && setup && (
        <form onSubmit={enable} style={form}>
          <Muted>1. Open your authenticator app and scan this picture (on the phone itself, tap the link below instead).</Muted>
          <Qr text={setup.uri} />
          <Muted>
            <a href={setup.uri}>Open in the authenticator app</a> · or type the key by hand: <code style={{ wordBreak: 'break-all' }}>{setup.secret}</code>
          </Muted>
          <Muted>2. Type the 6-digit code the app shows now.</Muted>
          {codeField('Code')}
          <Row wrap>
            <Button type="submit" variant="primary" disabled={busy || code.replace(/\s/g, '').length < 6}>
              Turn on
            </Button>
            <Button type="button" onClick={reset}>
              Cancel
            </Button>
          </Row>
        </form>
      )}

      {mode === 'codes' && (
        <div style={form}>
          <Muted>
            <strong>Save these recovery codes now</strong> — they are shown only once. Each works one time if you lose your phone (type one instead of the code).
          </Muted>
          <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: 'var(--bg-elev-2)', userSelect: 'all' }}>{codes.join('\n')}</pre>
          <Row wrap>
            <Button onClick={() => void navigator.clipboard?.writeText(codes.join('\n')).catch(() => undefined)}>Copy</Button>
            <Button variant="primary" onClick={reset}>
              I saved them
            </Button>
          </Row>
        </div>
      )}

      {(mode === 'disable' || mode === 'regen') && (
        <form onSubmit={mode === 'disable' ? disable : regen} style={form}>
          <Muted>{mode === 'disable' ? 'To turn it off, prove it is you: the password and a current code (or a recovery code).' : 'The old recovery codes stop working. Prove it is you: the password and a current code.'}</Muted>
          <Field label="Your password">
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
          {codeField('Code')}
          <Row wrap>
            <Button type="submit" variant={mode === 'disable' ? 'red' : 'primary'} disabled={busy || !password || !code.trim()}>
              {mode === 'disable' ? 'Turn off' : 'Make new codes'}
            </Button>
            <Button type="button" onClick={reset}>
              Cancel
            </Button>
          </Row>
        </form>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
