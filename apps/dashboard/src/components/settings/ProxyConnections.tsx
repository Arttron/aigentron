import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type ProxyConnection, type ProxyList } from '@/lib/api';
import { Badge, Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';

/**
 * Proxy connections for the agents' browser (docs/browser-proxy.md): paste the line the proxy seller gave (host;port;user;pass …), pick the one the browser
 * goes through — or direct. The login is kept on the server and never shown again; the browser reaches the proxy through the server's gateway, so the
 * choice applies at once, without restarting anything.
 */
export function ProxyConnections() {
  const [data, setData] = useState<ProxyList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api
      .listProxies()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(errMsg(e)));
  }, []);
  useEffect(load, [load]);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    guard(async () => {
      await api.addProxy({ name, line });
      setName('');
      setLine('');
    });

  const test = (p: ProxyConnection) => {
    setTests((t) => ({ ...t, [p.id]: 'testing…' }));
    api
      .testProxy(p.id)
      .then((r) => setTests((t) => ({ ...t, [p.id]: r.ok ? `✓ sites see ${r.ip} (${r.ms} ms)` : `✗ ${r.error}` })))
      .catch((e) => setTests((t) => ({ ...t, [p.id]: `✗ ${errMsg(e)}` })));
  };

  const items = data?.items ?? [];
  const active = items.find((p) => p.active) ?? null;

  return (
    <Card>
      <Row spaceBetween wrap>
        <SectionTitle>Browser proxy</SectionTitle>
        {data && (data.gateway.listening ? <Badge tone="done">{active ? `through “${active.name}”` : 'direct'}</Badge> : <Badge tone="blocked">gateway is off</Badge>)}
      </Row>
      <Muted>
        All the browser's traffic to the internet goes through the proxy you choose here (the project's own preview pages and the stack's services stay direct). The login stays on the server and is never shown again. It applies at once — no restart.
      </Muted>
      {error && <ErrorText>{error}</ErrorText>}
      {data && !data.gateway.listening && <ErrorText>The server's gateway is not running (PROXY_GATEWAY_PORT=0, or the port is taken): the browser cannot use a proxy chosen here.</ErrorText>}

      <div role="radiogroup" aria-label="Which proxy the browser uses" style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0' }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="radio" name="active-proxy" checked={!active} disabled={busy} onChange={() => void guard(() => api.setActiveProxy(null))} />
          <span>
            <strong>Direct</strong> <Muted>— the server's own address</Muted>
          </span>
        </label>
        {items.map((p) => (
          <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="radio" name="active-proxy" checked={p.active} disabled={busy} onChange={() => void guard(() => api.setActiveProxy(p.id))} />
              <span>
                <strong>{p.name}</strong>{' '}
                <Muted>
                  {p.server.replace(/^http:\/\//, '')}
                  {p.username ? ` · login ${p.username}` : ''}
                  {p.hasPassword ? ' · password saved' : ''}
                </Muted>
              </span>
            </label>
            <Button size="sm" disabled={busy} onClick={() => test(p)}>
              Test
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete the proxy “${p.name}”?${p.active ? ' The browser goes back to direct.' : ''}`)) void guard(() => api.removeProxy(p.id));
              }}
            >
              Delete
            </Button>
            {tests[p.id] && <Muted>{tests[p.id]}</Muted>}
          </div>
        ))}
        {data && items.length === 0 && <Muted>No proxies saved yet.</Muted>}
      </div>

      <strong>Add a proxy</strong>
      <Row wrap>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="lt-1" maxLength={40} style={{ width: 140 }} aria-label="Proxy name" />
        </Field>
        <Field label="Proxy line (as the seller gives it)">
          <input
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="res.proxy-seller.com;10000;user;pass"
            autoComplete="off"
            spellCheck={false}
            style={{ width: 'min(420px, 90vw)' }}
            aria-label="Proxy line"
          />
        </Field>
        <Button variant="primary" disabled={busy || !name.trim() || !line.trim()} onClick={() => void add()}>
          Save
        </Button>
      </Row>
      <Muted>
        Understood: <code>host;port;user;pass</code> · <code>user:pass@host:port</code> · <code>host:port:user:pass</code> · <code>http://user:pass@host:port</code> · <code>host:port</code>. HTTP / HTTPS proxies only (use the seller's HTTP port).
      </Muted>
    </Card>
  );
}
