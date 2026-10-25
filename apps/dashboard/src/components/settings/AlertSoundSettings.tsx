import { useEffect, useState } from 'react';
import { ALERT_SOUNDS, alertSoundReady, loadAlertSettings, playSound, saveAlertSettings, type AlertSettings, type AlertSoundName } from '@/lib/alert-sound';
import { Button, Card, Field, Muted, Row, SectionTitle } from '@/components/ui';

/** Settings → General → Alert sound: the sound this browser plays when an agent needs a person (an approval, a question). Stored in this browser only. */
export function AlertSoundSettings() {
  const [s, setS] = useState<AlertSettings>(() => loadAlertSettings());
  const [silent, setSilent] = useState(false);

  const change = (patch: Partial<AlertSettings>) =>
    setS((cur) => {
      const next = { ...cur, ...patch };
      saveAlertSettings(next);
      return next;
    });

  const test = async (sound: AlertSoundName = s.sound, volume: number = s.volume) => {
    setSilent(!(await playSound(sound, volume)));
  };

  // a browser keeps the page silent until it was touched once; the Test button is such a touch
  useEffect(() => setSilent(false), [s.sound, s.volume]);

  return (
    <Card>
      <SectionTitle>Alert sound</SectionTitle>
      <Muted>
        A short sound when an agent needs you — a new approval card (and, if you like, a question). It is chosen per browser: a phone and a desktop can differ. The browser plays it only after you have clicked
        on the page once.
      </Muted>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
        <input type="checkbox" checked={s.enabled} onChange={(e) => change({ enabled: e.target.checked })} /> Play a sound when an approval is needed
      </label>
      <div style={{ opacity: s.enabled ? 1 : 0.5, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Sound">
          <select value={s.sound} disabled={!s.enabled} onChange={(e) => { const sound = e.target.value as AlertSoundName; change({ sound }); void test(sound); }}>
            {ALERT_SOUNDS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Volume: ${Math.round(s.volume * 100)}%`}>
          <input type="range" min={0} max={1} step={0.05} value={s.volume} disabled={!s.enabled} onChange={(e) => change({ volume: Number(e.target.value) })} onPointerUp={() => void test()} style={{ padding: 0 }} />
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={s.questions} disabled={!s.enabled} onChange={(e) => change({ questions: e.target.checked })} /> Also when an agent asks a question
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={s.onlyWhenAway} disabled={!s.enabled} onChange={(e) => change({ onlyWhenAway: e.target.checked })} /> Only when this tab is not the one I am looking at
        </label>
        <Row wrap>
          <Button onClick={() => void test()} disabled={!s.enabled}>
            ▶ Test the sound
          </Button>
          {silent && <Muted>The browser kept the page silent — click anywhere on the page once and try again.</Muted>}
          {!silent && !alertSoundReady() && s.enabled && <Muted>Click anywhere on the page once so the browser lets it play by itself.</Muted>}
        </Row>
      </div>
    </Card>
  );
}
