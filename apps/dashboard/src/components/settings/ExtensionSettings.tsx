import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { connectExtension, disconnectExtension, extensionDownloadUrl, extensionOutdated, ping, useExtension } from '@/lib/extension-bridge';
import { Badge, Button, Card, ErrorText, Muted, Row, SectionTitle } from '@/components/ui';
import styles from '@/components/ExtensionBanner.module.css';

/** Add-ons → Extension: download the extension made for THIS server, install it, press Connect. */
export function ExtensionSettings() {
  const ext = useExtension();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.extensionInfo>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => void api.extensionInfo().then(setInfo).catch((e: Error) => setError(e.message));
  useEffect(load, []);
  // the list of browsers (version, access to sites) is told to the server by the extensions themselves: keep it fresh while this tab is open
  usePolling(load, 8000);
  // a browser that just connected (or was disconnected from its own popup) shows up in the list
  useEffect(() => {
    if (ext.connected) load();
  }, [ext.connected]);

  // browsers paired with this server that run an older extension, and this one if it is older too
  const old = (info?.devices ?? []).filter((d) => d.outdated);
  const thisOld = ext.detected && extensionOutdated(ext.version, info?.extensionVersion);
  const updatesNeeded = old.length + (thisOld && !old.length ? 1 : 0);
  const outdatedNames = old.length ? `${old.map((d) => `${d.label} (v${d.version})`).join(', ')} ${old.length === 1 ? 'is' : 'are'} older` : `this browser runs ${ext.version}`;

  return (
    <Card>
      <SectionTitle>Browser extension (Chrome, Edge, Brave)</SectionTitle>
      <Muted>
        Send the page you are on to an agent, answer approvals right on the page, and (later) let agents work in your browser. The extension is made for <strong>this server</strong>: its address
        and key are inside the file, nothing secret is. Press <strong>Connect</strong> here, in the dashboard: the extension gets its own identifier for this server, separate from any sign-in (on a server with no password it is bound to the address alone).
      </Muted>
      {error && <ErrorText>{error}</ErrorText>}
      {info?.available && updatesNeeded > 0 && (
        <div className={styles.banner} role="status" style={{ margin: '8px 0' }}>
          <span>
            <strong>The extension needs an update</strong> — this server ships version {info.extensionVersion}; {outdatedNames}. Click the extension&apos;s icon → <strong>Update the extension</strong> (it writes the new files into its folder and reloads), or download the zip below and unzip it over the same folder.
          </span>
        </div>
      )}
      {info && !info.available && <ErrorText>The extension files are not part of this installation (a minimal build without them).</ErrorText>}
      {info?.available && (
        <>
          <ol style={{ margin: '8px 0', paddingLeft: 20, lineHeight: 1.6 }}>
            <li>
              <a href={extensionDownloadUrl()} download>
                <Button size="sm" variant="primary">
                  Download the extension (zip)
                </Button>
              </a>{' '}
              and unzip it into a folder you will keep (for example <code>~/aigentron-extension</code>).
            </li>
            <li>
              Open <code>chrome://extensions</code>, switch on <strong>Developer mode</strong>, press <strong>Load unpacked</strong> and choose that folder.
            </li>
            <li>
              Reload this page, then press <strong>Connect</strong> below.
            </li>
          </ol>
          {extensionOutdated(ext.version, info.extensionVersion) && (
            <ErrorText>
              A newer extension is available: {ext.version} → {info.extensionVersion}. Easiest: click the extension's icon → <strong>Update the extension</strong> (it writes the new files into the folder you loaded and reloads). Or download the zip above, unzip it
              over the same folder and press <em>Reload</em> on <code>chrome://extensions</code>.
            </ErrorText>
          )}
          <Row wrap>
            <span>
              Version on this server: <strong>{info.extensionVersion ?? '—'}</strong>
              {' · '}in this browser: <strong>{ext.detected ? (ext.version ?? 'unknown') : 'not detected'}</strong>
            </span>
            {ext.detected && ext.version && info.extensionVersion && <Badge tone={extensionOutdated(ext.version, info.extensionVersion) ? 'review' : 'done'}>{extensionOutdated(ext.version, info.extensionVersion) ? 'update available' : 'up to date'}</Badge>}
          </Row>
          <Row wrap>
            {ext.detected ? <Badge tone={ext.connected ? 'done' : 'review'}>{ext.connected ? `connected${ext.user ? ` as ${ext.user}` : ''}` : ext.needsReconnect ? 'signed out — reconnect' : 'installed, not connected'}</Badge> : <Badge tone="neutral">not detected on this page</Badge>}
            {ext.detected && !ext.connected && (
              <Button size="sm" variant="primary" disabled={ext.busy} onClick={() => void connectExtension()}>
                {ext.busy ? 'Connecting…' : ext.needsReconnect ? 'Reconnect' : 'Connect'}
              </Button>
            )}
            {ext.detected && ext.connected && (
              <Button size="sm" onClick={disconnectExtension}>
                Disconnect
              </Button>
            )}
            {!ext.detected && (
              <Button size="sm" onClick={ping}>
                Look again
              </Button>
            )}
          </Row>
          {ext.error && <ErrorText>{ext.error}</ErrorText>}
          {info.devices.some((d) => d.allSites === false) && (
            <ErrorText>
              Agents cannot use {info.devices.filter((d) => d.allSites === false).map((d) => d.label).join(', ')} yet: Chrome has not given the extension access to websites. Click the extension icon → <strong>Allow agents to use my browser</strong>.
            </ErrorText>
          )}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <input
              type="checkbox"
              checked={info.agentsBrowser !== false}
              disabled={info.devices.length === 0}
              onChange={(e) => void api.extensionSetAgentsBrowser(e.target.checked).then(load).catch((err: Error) => setError(err.message))}
            />
            <span>
              Let agents use the browser (search, read, fill forms in their own window). Added to every agent automatically while a browser is connected; the site is asked about once per task, every submission always.
            </span>
          </label>
          <div style={{ marginTop: 6 }}>
            <strong>Connected browsers</strong>
            {info.devices.length === 0 ? (
              <Muted> — none yet</Muted>
            ) : (
              <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                {info.devices.map((d) => (
                  <li key={d.id}>
                    {d.label} · {d.user} · {d.version ? `v${d.version}` : 'version unknown'}{' '}
                    {d.allSites === false && <Badge tone="review">agents have no access to sites</Badge>}{' '}
                    {d.outdated ? <Badge tone="review">update available</Badge> : d.version ? <Badge tone="done">up to date</Badge> : null} · last seen {new Date(d.lastSeenAt).toLocaleString()}{' '}
                    <Button size="sm" onClick={() => void api.extensionRemoveDevice(d.id).then(load).catch((e: Error) => setError(e.message))}>
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Muted>
            Extension ID <code>{info.extensionId}</code> (fixed for this server — an update keeps your connection) · server version {info.version}
            {ext.version ? ` · installed extension ${ext.version}` : ''}. Addresses in the file: {info.origins.join(', ')}.             The extension tells you when a new version is available and can update itself in place (icon → <em>Update the extension</em>; you point it at its folder once).
          </Muted>
        </>
      )}
    </Card>
  );
}
