import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, type AddonInfo } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { Badge, Card, ErrorText, Muted, Row, SectionTitle } from '@/components/ui';
import { Command, STATUS, mb } from './BrowserPage';
import styles from './BrowserPage.module.css';

/** The local voice add-on's panel (docs/addons.md): speech recognition + synthesis on this server. The panel says whether it runs and what to type on the server. */
export function VoiceAddonPanel() {
  const [info, setInfo] = useState<AddonInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .getAddon('voice')
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
  const api_ = info?.state?.endpoints.api ?? null;

  return (
    <Card>
      <Row spaceBetween wrap>
        <SectionTitle>Local voice add-on</SectionTitle>
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
                Running{api_ ? <> at <code>{api_}</code></> : null}. Use it in <Link to="/settings">Settings → Voice</Link> (the button <em>Use it for recognition and speech</em>): Russian and English, the voice <code>auto</code> picks by the text.
              </li>
              <li>Recognition (Whisper) runs on the processor: a short voice message takes a few seconds; it uses about 1 GB of memory while it works.</li>
            </ul>
          )}
          {status === 'not-installed' && (
            <>
              <ul className={styles.req}>
                <li>
                  Needs about {mb(info.requires.ramMb)} of RAM and {mb(info.requires.diskMb)} of disk on the server (voices, the Whisper model, libraries).
                </li>
                <li>A service on the server (Debian / Ubuntu / Amazon Linux / Fedora). Free: no key, nothing leaves the machine.</li>
              </ul>
              {info.stateError && <ErrorText>The server has a state file for this add-on, but it is unusable: {info.stateError}</ErrorText>}
              <p className={styles.step}>Enable it on the server (over SSH), then come back to this page:</p>
              <Command text={info.commands.enable} hint="installs Piper voices (Russian, English) and Whisper as a service" />
              <Command text={`${info.commands.enable} --stt-model base`} hint="a lighter recognition model for a small server (or --no-stt for speech only)" />
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
                The add-on is enabled, but it does not answer{info.health?.error ? ` (${info.health.error})` : ''}. It may still be starting; this page checks again every 10 seconds. If it stays like this, look at its log on the server:
              </p>
              <Command text={info.commands.logs} />
            </>
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
