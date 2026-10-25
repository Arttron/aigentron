import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errMsg, type AddonInfo, type AddonStatus } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { usePolling } from '@/lib/use-polling';
import { Badge, Button, ButtonLink, Card, ErrorText, Muted, Row, SectionTitle, type BadgeTone } from '@/components/ui';
import { CopyButton } from '@/components/CopyButton';
import styles from './BrowserPage.module.css';

const POLL_MS = 10_000;
export const STATUS: Record<AddonStatus, { label: string; tone: BadgeTone }> = {
  'not-installed': { label: 'Not installed', tone: 'neutral' },
  'enabled-healthy': { label: 'Running', tone: 'done' },
  'enabled-unreachable': { label: 'Not answering', tone: 'failed' },
  disabled: { label: 'Disabled', tone: 'cancelled' },
};

const pad = (n: number) => String(n).padStart(2, '0');
export const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} GB` : `${n} MB`);
/** "1:59:30" / "9:05" — what is left of the viewing session. */
function left(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** A command to run on the server, with a copy button (nothing runs from the dashboard). */
export function Command({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className={styles.cmd}>
      <code>{text}</code>
      <CopyButton text={text} label="Copy command" />
      {hint && <Muted className={styles.cmdHint}>{hint}</Muted>}
    </div>
  );
}

/**
 * The browser add-on's panel on the Add-ons page (docs/addons.md): a real browser on the server. Not installed → what it is and the command to run;
 * running → the live view (noVNC, proxied behind the sign-in) filling the rest of the screen; not answering → what to check.
 */
export function BrowserAddonPanel() {
  const [info, setInfo] = useState<AddonInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .getAddon('browser')
      .then((i) => {
        setInfo(i);
        setError(null);
      })
      .catch((e) => setError(errMsg(e)));
  }, []);
  useEffect(load, [load]);
  usePolling(load, POLL_MS);

  const me = useAuth().status?.me;
  const mayView = !me || me.role === 'operator' || me.role === 'admin';
  const status = info?.status ?? null;
  const live = status === 'enabled-healthy' && mayView;

  // one viewing session = one mounted iframe; the server ends the stream after `sessionMinutes`, this clock says when
  const [session, setSession] = useState<{ key: number; startedAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (live && !session) setSession({ key: 1, startedAt: Date.now() });
    if (!live && session) setSession(null);
  }, [live, session]);
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session]);
  const limitMs = (info?.view?.sessionMinutes ?? 120) * 60_000;
  const remaining = session ? session.startedAt + limitMs - now : limitMs;
  const over = session !== null && remaining <= 0;
  const restart = () => setSession((s) => ({ key: (s?.key ?? 0) + 1, startedAt: Date.now() }));

  // the view fills what is left of the screen below the toolbar (measured, so nothing below ever needs scrolling)
  const frameRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(480);
  useLayoutEffect(() => {
    if (!live) return;
    const measure = () => {
      const el = frameRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const bottom = window.innerWidth <= 640 ? 96 : 20; // the floating assistant sits bottom-right on phones
      setHeight(Math.max(320, Math.round(window.innerHeight - top - bottom)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [live]);

  const fullscreen = () => {
    void frameRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  const chip = status ? <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge> : <Badge tone="neutral">Checking…</Badge>;
  const viewUrl = api.addonBrowserViewUrl();

  return (
    <>
      {error && (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}

      {live && info ? (
        <>
          <div className={styles.bar}>
            <span className={styles.chip}>{chip}</span>
            <Muted className={styles.meta}>
              {info.view ? `${Math.max(info.view.active, session ? 1 : 0)}/${info.view.maxSessions} watching · ` : ''}
              {over ? 'session ended' : `${left(remaining)} left`}
            </Muted>
            <span className={styles.grow} />
            <ButtonLink size="sm" href={viewUrl} target="_blank" rel="noopener">
              Open in a new tab ↗
            </ButtonLink>
            <Button size="sm" onClick={fullscreen}>
              Fullscreen
            </Button>
          </div>
          <p className={styles.warn}>⚠ Agents use this browser too: anything you sign in to here is visible to them.</p>
          <div ref={frameRef} className={styles.frame} style={{ height }}>
            {over || !session ? (
              <div className={styles.overlay}>
                <p>
                  Your viewing session ended after {info.view?.sessionMinutes ?? 120} minutes (the limit for one session). The browser itself keeps running on the server.
                </p>
                <Button variant="primary" onClick={restart}>
                  Start a new session
                </Button>
              </div>
            ) : (
              <iframe key={session.key} className={styles.iframe} src={viewUrl} title="Server browser" allow="clipboard-read; clipboard-write" allowFullScreen />
            )}
          </div>
        </>
      ) : (
        <Card>
          <Row spaceBetween wrap>
            <SectionTitle>Browser add-on</SectionTitle>
            <span className={styles.chip}>{chip}</span>
          </Row>
          {!info ? (
            <div className={styles.placeholder}>
              <Muted>{error ? 'The add-on status could not be read.' : 'Checking the add-on…'}</Muted>
            </div>
          ) : (
            <>
              <p className={styles.desc}>{info.description}</p>
              {status === 'enabled-healthy' && !mayView && (
                <Muted>The browser is running. Viewing it needs the operator or admin role — whoever watches can also type into it, and the agents' sessions are inside.</Muted>
              )}
              {status === 'not-installed' && (
                <>
                  <ul className={styles.req}>
                    <li>
                      Needs about {mb(info.requires.ramMb)} of RAM and {mb(info.requires.diskMb)} of disk on the server.
                    </li>
                    <li>Backends: {info.backends.map((b) => (b === 'bare' ? 'bare (a service on the server)' : 'Docker (a container)')).join(' or ')}.</li>
                    <li>Only the dashboard can reach its screen (behind the sign-in, operators and admins); agents reach it internally.</li>
                  </ul>
                  {info.stateError && <ErrorText>The server has a state file for this add-on, but it is unusable: {info.stateError}</ErrorText>}
                  <p className={styles.step}>Enable it on the server (over SSH), then come back to this page:</p>
                  <Command text={info.commands.enable} hint="installs the browser as a service — the usual choice" />
                  <Command text={info.commands.enableDocker} hint="the Docker variant: the browser runs in a container" />
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
                    The add-on is enabled, but its screen does not answer{info.health?.error ? ` (${info.health.error})` : ''}. It may still be starting; this page checks again every 10 seconds. If it stays like this, look
                    at its log on the server:
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
                  {info.state.browser ? ` · ${info.state.browser}` : ''}
                  {info.state.arch ? ` · ${info.state.arch}` : ''}
                  {info.state.installedAt ? ` · installed ${new Date(info.state.installedAt).toLocaleDateString()}` : ''}
                </Muted>
              )}
            </>
          )}
        </Card>
      )}
    </>
  );
}
