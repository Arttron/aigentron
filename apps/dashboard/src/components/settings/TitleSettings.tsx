import { useEffect, useState } from 'react';
import { api, type ProviderInfo } from '@/lib/api';
import { ModelSelect } from '@/components/ModelSelect';
import { Button, Card, Field, Muted, ErrorText, Row, SectionTitle } from '@/components/ui';

/** Settings → General → Task titles: tasks are named from their context by a small model. */
export function TitleSettings() {
  const [cfg, setCfg] = useState({ enabled: true, provider: '', model: '' });
  const [saved, setSaved] = useState(cfg);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void Promise.all([api.getTitleSettings(), api.listProviders().catch(() => [])])
      .then(([c, p]) => {
        setCfg(c);
        setSaved(c);
        setProviders(p);
      })
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);

  const usable = providers.filter((p) => p.kind !== 'codex' && p.authMode !== 'oauth-token');
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      setSaved(await api.saveTitleSettings(cfg));
      return 'Saved.';
    });
  const test = () =>
    run(async () => {
      if (dirty) setSaved(await api.saveTitleSettings(cfg));
      const r = await api.testTitle();
      if (!r.ok) throw new Error(r.error ?? 'The test failed.');
      return `Works (${r.provider}) — for “Сравни цены на датчик температуры DS18B20 у пяти поставщиков…” it made: «${r.title}»`;
    });

  return (
    <Card>
      <SectionTitle>Task titles</SectionTitle>
      <Muted>
        A new task is named from its context — what you wrote, the files you attached and, for a vague request, the first answer — by a small, cheap model, in the language of the request. Until then it
        shows the first line of your message. Titles you or a schedule set yourself are never changed. Costs a fraction of a cent per task; the request text goes to the chosen provider.
      </Muted>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} style={{ width: 'auto', margin: 0 }} /> Name tasks automatically
      </label>
      {cfg.enabled && (
        <>
          <Field label="Provider (empty = the default one)">
            <select value={cfg.provider} onChange={(e) => setCfg({ ...cfg, provider: e.target.value, model: '' })}>
              <option value="">— automatic —</option>
              {usable.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          {cfg.provider && (
            <Field label="Model (empty = a small one for this provider)">
              <ModelSelect provider={cfg.provider} value={cfg.model} onChange={(m) => setCfg({ ...cfg, model: m })} suggestions={['claude-haiku-4-5-20251001', 'gpt-4o-mini']} placeholder="— default —" />
            </Field>
          )}
        </>
      )}
      <Row wrap>
        <Button variant={dirty ? 'primary' : undefined} disabled={busy || !dirty} onClick={save}>
          Save
        </Button>
        <Button disabled={busy} onClick={test}>
          Try it
        </Button>
      </Row>
      {dirty && <Muted>● Not saved yet — press Save (Try it saves the selection too).</Muted>}
      {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
    </Card>
  );
}
