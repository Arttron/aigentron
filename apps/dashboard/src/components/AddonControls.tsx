import { useState } from 'react';
import { api, errMsg, type AddonInfo } from '@/lib/api';
import { Button, ErrorText, Muted, Row } from '@/components/ui';

/** Stop / Start / Restart for an installed add-on's service (Playwright, voice). Shown only when the server can do it; otherwise the command to type is shown. */
export function AddonControls({ info, onDone }: { info: AddonInfo; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  if (!info.state?.enabled) return null;
  const running = info.status === 'enabled-healthy';

  const run = async (action: 'start' | 'stop' | 'restart') => {
    if (action !== 'start' && !window.confirm(`${action === 'stop' ? 'Stop' : 'Restart'} ${info.title}? Pages open in it are closed.`)) return;
    setBusy(action);
    setNote(null);
    try {
      const r = await api.controlAddon(info.name, action);
      setNote({ ok: r.ok, text: r.message });
    } catch (e) {
      setNote({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(null);
      onDone();
    }
  };

  if (!info.control.available) {
    return <Muted>Stop / restart from here is not possible: {info.control.reason ?? 'not available'}.</Muted>;
  }
  return (
    <div style={{ margin: '8px 0' }}>
      <Row wrap>
        <Button size="sm" disabled={busy !== null} onClick={() => void run('restart')}>
          {busy === 'restart' ? 'Restarting…' : 'Restart'}
        </Button>
        {running ? (
          <Button size="sm" disabled={busy !== null} onClick={() => void run('stop')}>
            {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void run('start')}>
            {busy === 'start' ? 'Starting…' : 'Start'}
          </Button>
        )}
        {note && (note.ok ? <Muted>{note.text}</Muted> : <ErrorText>{note.text}</ErrorText>)}
      </Row>
    </div>
  );
}
