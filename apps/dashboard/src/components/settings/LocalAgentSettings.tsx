import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { CopyButton } from '@/components/CopyButton';
import { Badge, Button, Card, ErrorText, Muted, Row, SectionTitle } from '@/components/ui';
import { LocalAgentRulesEditor } from './LocalAgentRules';
import { LocalAgentRepos } from './LocalAgentRepos';
import { LocalAgentLlm } from './LocalAgentLlm';

type Info = Awaited<ReturnType<typeof api.localAgentInfo>>;
type Lookup = Awaited<ReturnType<typeof api.localAgentLookup>>;

const osName = (os: string | null) => (os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os === 'windows' ? 'Windows' : (os ?? '?'));

/** Add-ons → Local agent: a program on YOUR computer that server-side agents can work with, under approvals (docs/plan-local-agent.md). Nothing is installed on the server. */
/** `0.2.0` → `v0.2.0`; a development build (`dev-2d689e4-dirty`) is shown as it is. */
const versionLabel = (v?: string | null): string => (!v ? 'version unknown' : /^\d/.test(v) ? `v${v}` : v);

export function LocalAgentSettings() {
  const [params, setParams] = useSearchParams();
  const code = params.get('code');
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<Lookup | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [pair, setPair] = useState<{ code: string; expiresInSec: number } | null>(null);

  const load = () => void api.localAgentInfo().then(setInfo).catch((e: Error) => setError(e.message));
  useEffect(load, []);
  usePolling(load, 6000);

  // the link the computer printed: «<device> wants to connect — approve?»
  useEffect(() => {
    setAsked(null);
    setAskError(null);
    if (code) void api.localAgentLookup(code).then(setAsked).catch((e: Error) => setAskError(e.message));
  }, [code]);
  const clearCode = () => setParams((p) => (p.delete('code'), p), { replace: true });
  const decide = (approve: boolean) =>
    void api
      .localAgentApprove(code ?? '', approve)
      .then(() => {
        clearCode();
        load();
      })
      .catch((e: Error) => setAskError(e.message));

  const origin = window.location.origin;
  const install = `curl -fsSL ${origin}/api/local-agent/install.sh | sh`;

  return (
    <Card>
      <SectionTitle>Local agent (a program on your own computer)</SectionTitle>
      <Muted>
        It keeps one connection to this server and lets agents see and — in later stages, with your approval — change the code on <strong>your</strong> machine. Today: <strong>read only</strong> — you allow a repository, share it with a project, and that project&apos;s agents can look at its status, diff, history and files. Nothing is installed on the
        server and nothing listens on your computer: the program only dials out. It is built in Go (one file, no runtime). Safe copies of your unsaved work and fetch run on your machine by the rules below; changing your code through the server (commit, push) comes next (plan: <code>docs/plan-local-agent.md</code>).
      </Muted>
      {error && <ErrorText>{error}</ErrorText>}

      {code && (
        <div role="status" style={{ border: '1px solid var(--amber)', background: 'var(--amber-soft)', borderRadius: 8, padding: 10, margin: '10px 0' }}>
          {asked ? (
            <>
              <strong>{asked.info.device}</strong> ({osName(asked.info.os)} {asked.info.arch}
              {asked.info.version ? `, v${asked.info.version}` : ''}) wants to connect to this server. Check that the code on its screen is <code>{asked.userCode}</code>.
              <Row wrap>
                <Button size="sm" variant="primary" onClick={() => decide(true)}>
                  Approve
                </Button>
                <Button size="sm" onClick={() => decide(false)}>
                  Deny
                </Button>
              </Row>
            </>
          ) : askError ? (
            <>
              <ErrorText>{askError}</ErrorText>
              <Button size="sm" onClick={clearCode}>
                Close
              </Button>
            </>
          ) : (
            <Muted>Looking up the code…</Muted>
          )}
        </div>
      )}

      <div style={{ margin: '10px 0' }}>
        <strong>Install (macOS, Linux)</strong>
        <Row wrap>
          <code style={{ wordBreak: 'break-all' }}>{install}</code>
          <CopyButton text={install} label="Copy the command" />
        </Row>
        <Muted>
          It downloads the program from this server (checked against the release&apos;s SHA-256), puts it in <code>~/.local/bin</code> and opens your browser to approve the connection here. Windows: the zip is built by the release; an installer comes later.
        </Muted>
      </div>

      <div style={{ margin: '10px 0' }}>
        <strong>A computer without a browser</strong> (over ssh)
        <Row wrap>
          <Button
            size="sm"
            onClick={() =>
              void api
                .localAgentPair()
                .then(setPair)
                .catch((e: Error) => setError(e.message))
            }
          >
            Create a one-use code
          </Button>
          {pair && (
            <>
              <code style={{ wordBreak: 'break-all' }}>{`aigentron pair --server ${origin} --code ${pair.code}`}</code>
              <CopyButton text={`aigentron pair --server ${origin} --code ${pair.code}`} label="Copy the command" />
              <Muted>valid {Math.round(pair.expiresInSec / 60)} min, once</Muted>
            </>
          )}
        </Row>
      </div>

      <div style={{ marginTop: 6 }}>
        <strong>Connected computers</strong>
        {!info || info.devices.length === 0 ? (
          <Muted> — none yet</Muted>
        ) : (
          <div style={{ display: 'grid', gap: 8, margin: '8px 0' }}>
            {info.devices.map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
                <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ overflowWrap: 'anywhere' }}>{d.label}</strong>
                    <Badge tone={d.online ? 'done' : 'neutral'}>{d.online ? 'online' : 'offline'}</Badge>
                    {d.outdated && <Badge tone="review">update available</Badge>}
                  </div>
                  <Muted>
                    {d.user} · {osName(d.os)} {d.arch ?? ''} · {versionLabel(d.version)} · {d.online ? 'connected' : `last seen ${new Date(d.lastSeenAt).toLocaleString()}`}
                  </Muted>
                </div>
                <Button size="sm" onClick={() => void api.localAgentRemoveDevice(d.id).then(load).catch((e: Error) => setError(e.message))}>
                  Disconnect
                </Button>
              </div>
            ))}
          </div>
        )}
        {info?.devices.some((d) => d.outdated) && <Muted>To update, run <code>aigentron update</code> on that computer (it installs this server&apos;s version, keeps the old one as a backup and restarts the background service). Older programs without that command: run the install command above again.</Muted>}
      </div>
      {info && <LocalAgentRepos devices={info.devices} bindings={info.bindings} reload={load} />}
      {info && <LocalAgentLlm />}
      {info && <LocalAgentRulesEditor rulesRev={info.rulesRev} devices={info.devices} />}
      <Muted>Server version {info?.version ?? '…'}. Disconnecting a computer tells it at once; it will not reconnect until you sign in again with <code>aigentron login</code>.</Muted>
    </Card>
  );
}
