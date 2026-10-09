import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '@/lib/config';
import { Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';

interface Listener {
  kind: 'http' | 'https';
  port: number;
  state: 'listening' | 'off' | 'error';
  role?: 'app' | 'redirect';
  error?: string;
}
interface Cert {
  subject: string;
  issuer: string;
  names: string[];
  validTo: string;
  daysLeft: number;
  selfSigned: boolean;
}
interface WebStatus {
  apiPort: number;
  config: { httpPort: number; httpsPort: number; redirect: boolean };
  listeners: Listener[];
  certificate: Cert | null;
  certificateError: string | null;
  uncoveredDomains: string[];
}

/** Settings → General → Web server: which ports the server listens on, and its HTTPS certificate. */
export function WebServerSettings() {
  const [st, setSt] = useState<WebStatus | null>(null);
  const [httpPort, setHttpPort] = useState('80');
  const [httpsPort, setHttpsPort] = useState('443');
  const [redirect, setRedirect] = useState(true);
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`${API_BASE}/web-server`, { cache: 'no-store' }).catch(() => null);
    if (!r?.ok) return;
    const j = (await r.json()) as WebStatus;
    setSt(j);
    setHttpPort(String(j.config.httpPort));
    setHttpsPort(String(j.config.httpsPort));
    setRedirect(j.config.redirect);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const call = async (path: string, method: string, body?: unknown, ok = 'Saved.') => {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`${API_BASE}/web-server${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    const j = (await r?.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setBusy(false);
    if (!r?.ok || j.ok === false) return setMsg({ ok: false, text: j.error ?? 'Could not save.' });
    setMsg({ ok: true, text: ok });
    await load();
    return true;
  };

  if (!st) return null;
  const label = (l: Listener) => {
    if (l.state === 'off') return l.kind === 'https' ? 'HTTPS — off (no certificate installed)' : 'HTTP — off';
    const what = l.role === 'redirect' ? 'redirects domain names to HTTPS' : 'serves the dashboard';
    return l.state === 'listening' ? `${l.kind.toUpperCase()} :${l.port} — ${what}` : `${l.kind.toUpperCase()} :${l.port} — could not start (${l.error})`;
  };

  return (
    <Card>
      <SectionTitle>Web server — ports and HTTPS certificate</SectionTitle>
      <Muted>
        The server always answers on port <code>{st.apiPort}</code> (HTTP). <strong>Port 80</strong> is optional — switch it on below. Once a certificate is installed it serves <strong>HTTPS on 443</strong>
        and port 80 (when on) redirects domain names to HTTPS (IP addresses and local names keep working over plain HTTP). Only the domains in <em>Access</em> above are served — set them first.
      </Muted>
      <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
        {st.listeners.map((l) => (
          <li key={l.kind} style={{ color: l.state === 'error' ? 'var(--red)' : undefined }}>
            {label(l)}
          </li>
        ))}
      </ul>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 8px' }}>
        <input type="checkbox" checked={httpPort !== '0' && httpPort !== ''} onChange={(e) => setHttpPort(e.target.checked ? '80' : '0')} style={{ width: 'auto' }} /> Listen on HTTP port 80
      </label>
      <Row wrap>
        <Field label="HTTP port (0 = off)">
          <input value={httpPort} onChange={(e) => setHttpPort(e.target.value)} inputMode="numeric" style={{ width: 110 }} />
        </Field>
        <Field label="HTTPS port (0 = off)">
          <input value={httpsPort} onChange={(e) => setHttpsPort(e.target.value)} inputMode="numeric" style={{ width: 110 }} />
        </Field>
      </Row>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 8px' }}>
        <input type="checkbox" checked={redirect} onChange={(e) => setRedirect(e.target.checked)} style={{ width: 'auto' }} /> With a certificate, redirect port 80 to HTTPS
      </label>
      <Row wrap>
        <Button disabled={busy} onClick={() => call('/config', 'PUT', { httpPort, httpsPort, redirect })}>
          Save ports
        </Button>
      </Row>
      <Muted>Ports below 1024 need the server to run as root (the default on a bare-metal install) and, under Docker, the ports published (<code>-p 80:80 -p 443:443</code>).</Muted>

      <SectionTitle>Certificate</SectionTitle>
      {st.certificate ? (
        <>
          <Muted>
            Installed: <strong>{st.certificate.subject}</strong> — valid for {st.certificate.names.join(', ') || '—'}; issued by {st.certificate.issuer}
            {st.certificate.selfSigned ? ' (self-signed — browsers will warn)' : ''}; expires {st.certificate.validTo.slice(0, 10)} ({st.certificate.daysLeft} days left
            {st.certificate.daysLeft < 14 ? ' — renew it soon!' : ''}).
          </Muted>
          {st.uncoveredDomains.length > 0 && <ErrorText>Allowed domains this certificate does not cover: {st.uncoveredDomains.join(', ')} — browsers will show a warning there.</ErrorText>}
          <Row wrap>
            <Button variant="red" disabled={busy} onClick={() => confirm('Remove the certificate? HTTPS on the server stops.') && call('/certificate', 'DELETE', undefined, 'Certificate removed.')}>
              Remove certificate
            </Button>
          </Row>
          <Muted>To replace it, paste a new one below.</Muted>
        </>
      ) : (
        <Muted>None installed — the server speaks plain HTTP. Paste a certificate and its private key (PEM) to switch on HTTPS. A free option: a Cloudflare Origin Certificate or Let&rsquo;s Encrypt (see docs/remote-access.md).</Muted>
      )}
      {st.certificateError && <ErrorText>The installed certificate is unusable: {st.certificateError}</ErrorText>}
      <Field label="Certificate (full chain, PEM)">
        <textarea rows={4} value={cert} onChange={(e) => setCert(e.target.value)} placeholder={'-----BEGIN CERTIFICATE-----\n…'} spellCheck={false} />
      </Field>
      <Field label="Private key (PEM, not password-protected)">
        <textarea rows={3} value={key} onChange={(e) => setKey(e.target.value)} placeholder={'-----BEGIN PRIVATE KEY-----\n…'} spellCheck={false} />
      </Field>
      <Row wrap>
        <Button
          variant="primary"
          disabled={busy || !cert.trim() || !key.trim()}
          onClick={async () => {
            if (await call('/certificate', 'PUT', { cert, key }, 'Certificate installed — HTTPS is on.')) {
              setCert('');
              setKey('');
            }
          }}
        >
          Install certificate
        </Button>
        {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
      </Row>
      <Muted>The key stays on the server (in the protected secrets folder) and is never shown again.</Muted>
    </Card>
  );
}
