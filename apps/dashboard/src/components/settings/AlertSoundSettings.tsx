import { useEffect, useRef, useState } from 'react';
import { ALERT_SOUNDS, alertSoundReady, checkSoundData, forgetCustomSound, loadAlertSettings, playSound, saveAlertSettings, type AlertSettings, type AlertSoundName } from '@/lib/alert-sound';
import { CUSTOM_PREFIX, MAX_CUSTOM_SOUNDS, MAX_SOUND_BYTES, MAX_SOUND_SECONDS, customIdOf, listCustomSounds, removeCustomSound, saveCustomSound, validateSoundFile, type CustomSound } from '@/lib/custom-sounds';
import { Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';

/** Settings → General → Alert sound: the sound this browser plays when an agent needs a person (an approval, a question). Stored in this browser only. */
export function AlertSoundSettings() {
  const [s, setS] = useState<AlertSettings>(() => loadAlertSettings());
  const [silent, setSilent] = useState(false);
  const [mine, setMine] = useState<CustomSound[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void listCustomSounds().then(setMine);
  }, []);

  const change = (patch: Partial<AlertSettings>) =>
    setS((cur) => {
      const next = { ...cur, ...patch };
      saveAlertSettings(next);
      return next;
    });

  const test = async (sound: AlertSoundName = s.sound, volume: number = s.volume) => {
    setSilent(!(await playSound(sound, volume)));
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    const bad = validateSoundFile(file, mine.length);
    if (bad) return setUploadError(bad);
    const data = await file.arrayBuffer();
    const unreadable = await checkSoundData(data);
    if (unreadable) return setUploadError(unreadable);
    const added = await saveCustomSound(file.name, data);
    setMine(await listCustomSounds());
    const sound = `${CUSTOM_PREFIX}${added.id}` as AlertSoundName;
    change({ sound });
    void test(sound);
  };
  const remove = async (c: CustomSound) => {
    await removeCustomSound(c.id);
    forgetCustomSound(c.id);
    setMine(await listCustomSounds());
    if (customIdOf(s.sound) === c.id) change({ sound: 'uhoh' });
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
            <optgroup label="Built in">
              {ALERT_SOUNDS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </optgroup>
            {mine.length > 0 && (
              <optgroup label="Your sounds">
                {mine.map((c) => (
                  <option key={c.id} value={`${CUSTOM_PREFIX}${c.id}`}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        <div>
          <Row wrap>
            <input ref={picker} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
            <Button onClick={() => picker.current?.click()} disabled={!s.enabled || mine.length >= MAX_CUSTOM_SOUNDS}>
              ⬆ Upload your own sound
            </Button>
            <Muted>mp3, wav, ogg or m4a · up to {MAX_SOUND_BYTES / 1024} KB and {MAX_SOUND_SECONDS} s · {mine.length}/{MAX_CUSTOM_SOUNDS} · kept in this browser only</Muted>
          </Row>
          {uploadError && <ErrorText>{uploadError}</ErrorText>}
          {mine.map((c) => (
            <Row key={c.id} spaceBetween>
              <span>🎵 {c.name} <Muted>({(c.size / 1024).toFixed(0)} KB)</Muted></span>
              <Row>
                <Button size="sm" onClick={() => void test(`${CUSTOM_PREFIX}${c.id}` as AlertSoundName)}>
                  ▶
                </Button>
                <Button size="sm" variant="red" onClick={() => void remove(c)} title="Remove this sound">
                  ✕
                </Button>
              </Row>
            </Row>
          ))}
        </div>
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
