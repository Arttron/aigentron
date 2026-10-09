import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '@/lib/config';
import { Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';

interface AccessInfo {
  allowedHosts: string[];
  publicHost: string | null;
  yourHost: string;
  enforced: boolean;
  strict?: boolean;
  server?: { port: number; listenHost: string; bindAddress: string | null; publicUrl: string | null };
}

/** Settings → General → Access: which domain names this server answers to. */
export function AccessSettings() {
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [text, setText] = useState('');
  const [strict, setStrict] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`${API_BASE}/access`, { cache: 'no-store' }).catch(() => null);
    if (!r?.ok) return;
    const j = (await r.json()) as AccessInfo;
    setInfo(j);
    setText(j.allowedHosts.join('\n'));
    setStrict(Boolean(j.strict));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`${API_BASE}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedHosts: text, strict }),
    }).catch(() => null);
    const j = (await r?.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setBusy(false);
    if (!r?.ok || !j.ok) return setMsg({ ok: false, text: j.error ?? 'Could not save.' });
    setMsg({ ok: true, text: 'Saved. Takes effect immediately.' });
    await load();
  };

  if (!info) return null;
  return (
    <Card>
      <SectionTitle>Access — allowed domains</SectionTitle>
      <Muted>
        Domain names this server answers to when it is published on the internet (one per line; <code>*.example.com</code> allows every
        subdomain). Leave empty to accept any name. <strong>Always allowed, whatever you enter:</strong> <code>localhost</code>, IP addresses and
        single-word names — so opening the server by IP, an SSH/port forward or the local network keeps working, and you cannot lock yourself out.
      </Muted>
      <Field label="Allowed domains">
        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'dev.example.com\n*.team.example.org'}
          spellCheck={false}
        />
      </Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '8px 0' }}>
        <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} style={{ width: 'auto', marginTop: 4 }} />
        <span>
          <strong>Only these domains</strong> — refuse access by IP address or bare server name (they get an error page, not the dashboard). The server itself (and an SSH tunnel to
          it) still works. Needs at least one domain above.
        </span>
      </label>
      <Muted>
        You are connected via <code>{info.yourHost || 'unknown'}</code>
        {info.publicHost ? (
          <>
            . <code>{info.publicHost}</code> (from <code>PUBLIC_URL</code>) is always allowed.
          </>
        ) : (
          '.'
        )}{' '}
        {info.enforced ? 'The list is being enforced.' : 'Nothing is enforced yet (the list is empty).'}
      </Muted>
      <Row wrap>
        <Button variant="primary" disabled={busy} onClick={save}>
          Save domains
        </Button>
        {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
      </Row>
      {info.server && (
        <Muted>
          <strong>How the server is reachable</strong> (set in the server&rsquo;s <code>.env</code> — change with <code>aigentron access</code> on the server, then restart):{' '}
          port <code>{info.server.port}</code>, listens on <code>{info.server.listenHost}</code>
          {info.server.bindAddress ? (
            <>
              , published on <code>{info.server.bindAddress}</code>
            </>
          ) : null}
          , public address {info.server.publicUrl ? <code>{info.server.publicUrl}</code> : <em>not set</em>}.
        </Muted>
      )}
      <Muted>
        This limits <em>where</em> the page can be opened; <em>who</em> may use it is decided by the passwords (Security). For a
        second, independent layer see Cloudflare Access in <code>docs/remote-access.md</code>.
      </Muted>
    </Card>
  );
}
