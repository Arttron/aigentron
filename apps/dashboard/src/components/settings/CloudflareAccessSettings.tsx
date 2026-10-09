import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '@/lib/config';
import { Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';

interface CfInfo {
  configured: boolean;
  enabled: boolean;
  teamDomain: string;
  audSet: boolean;
  audHint: string | null;
}
interface CfTest {
  keys: { ok: boolean; count?: number; error?: string };
  you: { present: boolean; ok?: boolean; email?: string | null; error?: string };
}

/** Settings → General → Cloudflare Access: make the server itself check Access's sign-in token. */
export function CloudflareAccessSettings() {
  const [info, setInfo] = useState<CfInfo | null>(null);
  const [team, setTeam] = useState('');
  const [aud, setAud] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<CfTest | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`${API_BASE}/cloudflare-access`, { cache: 'no-store' }).catch(() => null);
    if (!r?.ok) return;
    const j = (await r.json()) as CfInfo;
    setInfo(j);
    setTeam(j.teamDomain);
    setEnabled(j.enabled);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    setTest(null);
    const r = await fetch(`${API_BASE}/cloudflare-access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled, teamDomain: team, aud }),
    }).catch(() => null);
    const j = (await r?.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setBusy(false);
    if (!r?.ok || !j.ok) return setMsg({ ok: false, text: j.error ?? 'Could not save.' });
    setAud('');
    setMsg({ ok: true, text: enabled ? 'Saved. Public addresses now require a Cloudflare Access sign-in.' : 'Saved (switched off).' });
    await load();
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    const r = await fetch(`${API_BASE}/cloudflare-access/test`, { method: 'POST' }).catch(() => null);
    setBusy(false);
    if (r?.ok) setTest((await r.json()) as CfTest);
    else setMsg({ ok: false, text: 'Test failed.' });
  };

  if (!info) return null;
  return (
    <Card>
      <SectionTitle>Cloudflare Access — sign-in check</SectionTitle>
      <Muted>
        A second, independent layer: when on, a request that arrives under a real domain name must carry the signed token that Cloudflare
        Access adds after its own login. Reaching the server around Cloudflare (a tunnel hostname without an Access policy) then gets
        nothing. <code>localhost</code>, IP addresses and the local network are never affected. The password sign-in still applies on top.
      </Muted>
      <Field label="Team domain">
        <input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="yourteam.cloudflareaccess.com" spellCheck={false} />
      </Field>
      <Field label={`Application Audience (AUD) tag${info.audSet ? ` — saved (…${info.audHint?.slice(1) ?? ''}), leave empty to keep` : ''}`}>
        <input value={aud} onChange={(e) => setAud(e.target.value)} placeholder="the long code on the Access application's Overview page" spellCheck={false} />
      </Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 'auto' }} /> Require Cloudflare Access on public addresses
      </label>
      <Row wrap>
        <Button variant="primary" disabled={busy || !team} onClick={save}>
          Save
        </Button>
        <Button disabled={busy || !info.configured} onClick={runTest}>
          Test
        </Button>
        {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
      </Row>
      {test && (
        <Muted>
          {test.keys.ok ? `✓ Cloudflare's signing keys fetched (${test.keys.count}).` : `✗ Could not fetch Cloudflare's keys: ${test.keys.error}`}{' '}
          {!test.you.present
            ? 'This browser request did not come through Cloudflare Access (open this page on your public address to see who Access says you are).'
            : test.you.ok
              ? `✓ This request is signed in through Access as ${test.you.email ?? 'a service token'}.`
              : `✗ This request carries an Access token that does not verify (${test.you.error}).`}
        </Muted>
      )}
      <Muted>
        Where to find the values: Cloudflare Zero Trust → Settings → <em>Team domain</em>; Access → Applications → your application → <em>Overview →
        Application Audience (AUD) Tag</em>. See <code>docs/remote-access.md</code>.
      </Muted>
    </Card>
  );
}
