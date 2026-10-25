import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type AddonInfo } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { Badge, Card, ErrorText, Muted, Row, SectionTitle } from '@/components/ui';
import { Command, STATUS, mb } from './BrowserPage';
import styles from './BrowserPage.module.css';

/**
 * The Playwright add-on's panel (docs/addons.md): a headless browser for the AGENTS, behind the `playwright` MCP server. Nothing to watch — the
 * panel says whether it is installed and running and what to type on the server. Separate from the Browser add-on (the visible, personal one).
 */
export function PlaywrightAddonPanel() {
  const [info, setInfo] = useState<AddonInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .getAddon('playwright')
      .then((i) => {
        setInfo(i);
        setError(null);
      })
      .catch((e) => setError(errMsg(e)));
  }, []);
  useEffect(load, [load]);
  usePolling(load, 10_000);

  const status = info?.status ?? null;
  const chip = status ? <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge> : <Badge tone="neutral">Checking…</Badge>;
  const mcp = info?.state?.endpoints.mcp ?? null;

  return (
    <Card>
      <Row spaceBetween wrap>
        <SectionTitle>Playwright add-on</SectionTitle>
        <span className={styles.chip}>{chip}</span>
      </Row>
      {error && <ErrorText>{error}</ErrorText>}
      {!info ? (
        <div className={styles.placeholder}>
          <Muted>{error ? 'The add-on status could not be read.' : 'Checking the add-on…'}</Muted>
        </div>
      ) : (
        <>
          <p className={styles.desc}>{info.description}</p>
          {status === 'enabled-healthy' && (
            <ul className={styles.req}>
              <li>
                Running{mcp ? <> at <code>{mcp}</code></> : null}. Agents that have the <code>playwright</code> MCP server in their list use it — nothing else to set up.
              </li>
              <li>Every session starts clean (nothing is kept between them). Nothing to watch here: it is headless.</li>
              <li>A page open in it takes 0.5–1.5 GB of memory — on a small server run one browser task at a time.</li>
            </ul>
          )}
          {status === 'not-installed' && (
            <>
              <ul className={styles.req}>
                <li>
                  Needs about {mb(info.requires.ramMb)} of RAM (while a page is open) and {mb(info.requires.diskMb)} of disk on the server.
                </li>
                <li>It is a service on the server (Debian / Ubuntu / Amazon Linux / Fedora). On a Docker install it is the compose profile instead.</li>
                <li>Different from the Browser add-on: that one is the visible, personal browser; this one is the agents' own throw-away headless browser.</li>
              </ul>
              {info.stateError && <ErrorText>The server has a state file for this add-on, but it is unusable: {info.stateError}</ErrorText>}
              <p className={styles.step}>Enable it on the server (over SSH), then come back to this page:</p>
              <Command text={info.commands.enable} hint="installs the MCP server and its Chromium as a service" />
              <Command text="docker compose --profile mcp up -d playwright-mcp" hint="a Docker install: the same MCP server as a container" />
              <Muted>Nothing is installed from the dashboard; it only shows what is on the server. Details: docs/addons.md.</Muted>
            </>
          )}
          {status === 'disabled' && (
            <>
              <p className={styles.step}>The add-on is installed but switched off on the server. To switch it on:</p>
              <Command text={info.commands.enable} />
            </>
          )}
          {status === 'enabled-unreachable' && (
            <>
              <p className={styles.step}>
                The add-on is enabled, but its MCP server does not answer{info.health?.error ? ` (${info.health.error})` : ''}. It may still be starting; this page checks again every 10 seconds. If it stays like this, look at its log
                on the server:
              </p>
              <Command text={info.commands.logs} />
              {info.state?.notes.length ? (
                <ul className={styles.req}>
                  {info.state.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          {info.state && (
            <Muted className={styles.fine}>
              {info.state.backend === 'docker' ? 'Docker' : 'Bare'} install{info.state.version ? ` · ${info.state.version}` : ''}
              {info.state.arch ? ` · ${info.state.arch}` : ''}
              {info.state.installedAt ? ` · installed ${new Date(info.state.installedAt).toLocaleDateString()}` : ''}
            </Muted>
          )}
          {status !== 'not-installed' && (
            <Muted className={styles.fine}>
              On the server: <code>{info.commands.logs}</code> · <code>{info.commands.disable}</code>
            </Muted>
          )}
        </>
      )}
    </Card>
  );
}
