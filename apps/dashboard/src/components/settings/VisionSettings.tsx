import { useEffect, useState } from 'react';
import { useAction } from '@/lib/use-settings-resource';
import { api, type ProviderInfo } from '@/lib/api';
import { ModelSelect } from '@/components/ModelSelect';
import { Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';

/** Vision-capable models worth suggesting per kind of provider (the provider's own list follows in the drop-down). */
const SUGGESTED: Record<string, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o'],
  anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'],
  deepseek: [],
  ollama: ['qwen3-vl:latest', 'llama3.2-vision'],
};

/** Settings → Vision: which model looks at photos and video frames for the agents (look_at / video_digest tools). */
export function VisionSettings() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [status, setStatus] = useState<{ ffmpeg: boolean; sttReady: boolean } | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [saved, setSaved] = useState({ provider: '', model: '' });
  const { busy, msg, setMsg, run } = useAction();

  useEffect(() => {
    void Promise.all([api.listProviders().catch(() => []), api.mediaStatus()])
      .then(([ps, st]) => {
        setProviders(ps);
        setStatus(st);
        setProvider(st.vision?.provider ?? '');
        setModel(st.vision?.model ?? '');
        setSaved({ provider: st.vision?.provider ?? '', model: st.vision?.model ?? '' });
      })
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);

  // Subscription logins (Claude / Codex sign-in) can't be called as a plain API.
  const usable = providers.filter((p) => p.kind !== 'codex' && p.authMode !== 'oauth-token');

  const dirty = provider !== saved.provider || model !== saved.model;
  const persist = async () => {
    await api.saveVision(provider && model ? { provider, model } : null);
    setSaved(provider && model ? { provider, model } : { provider: '', model: '' });
  };
  const save = () => run(async () => {
    await persist();
    return provider && model ? 'Saved.' : 'Vision is switched off.';
  });
  // the test always uses what is on screen: unsaved changes are saved first
  const test = () => run(async () => {
    if (dirty) await persist();
    const r = await api.testVision();
    if (!r.ok) throw new Error(r.error ?? 'The test failed.');
    return `Works — it answered: “${r.answer}”`;
  });

  return (
    <Card>
      <SectionTitle>Vision — let agents look at photos and video</SectionTitle>
      <Muted>
        The <code>look_at</code> and <code>video_digest</code> tools show photos (and frames of a video) to this model and give the agent its description. Pick a model that can see
        images — your agent's own model does not matter. If you leave it off, an agent running on a cloud model (Claude, OpenAI-style) uses its own model for this; other agents get an error. Photos and frames leave this server for the chosen provider, and it costs tokens (a local Ollama vision model is free).
      </Muted>
      {status && (
        <Muted>
          ffmpeg (video → frames): {status.ffmpeg ? '✅ installed' : '❌ not installed — videos cannot be processed'} · speech recognition for the soundtrack:{' '}
          {status.sttReady ? '✅ on' : '— off (Settings → Voice); the video is then described by its frames only'}
        </Muted>
      )}
      <Field label="Provider">
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">— off —</option>
          {usable.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Model">
        <ModelSelect provider={provider} value={model} onChange={setModel} suggestions={SUGGESTED[providers.find((p) => p.name === provider)?.kind ?? ''] ?? []} placeholder="— choose a model —" />
      </Field>
      <Row wrap>
        <Button variant={dirty ? 'primary' : undefined} disabled={busy || !dirty} onClick={save}>
          Save
        </Button>
        <Button disabled={busy || !provider || !model} onClick={test}>
          Test (shows it a red square)
        </Button>
      </Row>
      {dirty && <Muted>● Not saved yet — press Save (the Test button saves the selection too).</Muted>}
      {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
    </Card>
  );
}
