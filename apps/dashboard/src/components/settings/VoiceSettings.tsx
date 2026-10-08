import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ProviderInfo } from '@/lib/api';
import { loadVoice, voiceApi, type VoiceSettings as VoiceCfg } from '@/lib/voice';
import { Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';
import { VoiceTryout } from './VoiceTryout';
import styles from './VoiceSettings.module.css';

const STT_MODELS = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1', 'whisper-large-v3-turbo'];
const TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const LANGS: [string, string][] = [['', 'automatic'], ['en', 'English'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['pl', 'Polish']];

interface Draft {
  sttOn: boolean;
  sttProvider: string;
  sttModel: string;
  sttLang: string;
  ttsOn: boolean;
  ttsProvider: string;
  ttsModel: string;
  ttsVoice: string;
  ttsMax: number;
}

const fromCfg = (c: VoiceCfg | null): Draft => ({
  sttOn: !!c?.stt,
  sttProvider: c?.stt?.provider ?? '',
  sttModel: c?.stt?.model ?? 'gpt-4o-mini-transcribe',
  sttLang: c?.stt?.language ?? '',
  ttsOn: !!c?.tts,
  ttsProvider: c?.tts?.provider ?? '',
  ttsModel: c?.tts?.model ?? 'gpt-4o-mini-tts',
  ttsVoice: c?.tts?.voice ?? 'alloy',
  ttsMax: c?.tts?.maxChars ?? 1500,
});

/** Settings → Voice: speech recognition (voice messages in) and speech synthesis (read answers aloud). */
export function VoiceSettings() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [d, setD] = useState<Draft>(fromCfg(null));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  const [saved, setSaved] = useState<VoiceCfg | null>(null);

  const load = useCallback(async () => {
    const [ps, cfg] = await Promise.all([api.listProviders().catch(() => []), loadVoice(true)]);
    setProviders(ps);
    setD(fromCfg(cfg));
    setSaved(cfg);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Only OpenAI-style providers can serve audio (OpenAI itself, Groq, a local Whisper/TTS server…).
  const usable = useMemo(() => providers.filter((p) => p.kind === 'openai'), [providers]);
  const where = (name: string) => {
    const p = providers.find((x) => x.name === name);
    if (!p) return '';
    try {
      return p.baseUrl ? new URL(p.baseUrl).host : 'api.openai.com';
    } catch {
      return p.baseUrl ?? '';
    }
  };
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    setTest(null);
    try {
      await voiceApi.save({
        stt: d.sttOn ? { provider: d.sttProvider, model: d.sttModel, language: d.sttLang } : null,
        tts: d.ttsOn ? { provider: d.ttsProvider, model: d.ttsModel, voice: d.ttsVoice, maxChars: d.ttsMax } : null,
      });
      setMsg({ ok: true, text: 'Saved.' });
      setSaved(await loadVoice(true));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const r = await voiceApi.test();
      const lines: string[] = [];
      if (r.tts) lines.push(r.tts.ok ? `🔊 speech synthesis works (${Math.round((r.tts.bytes ?? 0) / 1024)} KB of audio)` : `🔊 speech synthesis FAILED: ${r.tts.error}`);
      if (r.stt) lines.push(r.stt.ok ? `🎤 recognition works — it heard: “${r.stt.heard}”` : `🎤 recognition: ${r.stt.error}`);
      setTest(lines.join('\n') || 'Nothing is switched on yet.');
    } catch (e) {
      setTest((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const providerSelect = (value: string, on: (v: string) => void) => (
    <select value={value} onChange={(e) => on(e.target.value)}>
      <option value="">— choose a provider —</option>
      {usable.map((p) => (
        <option key={p.name} value={p.name}>
          {p.name}
        </option>
      ))}
    </select>
  );

  return (
    <Card>
      <SectionTitle>Voice — talk to the assistant and hear it</SectionTitle>
      <Muted>
        Speak instead of typing: Telegram voice messages and the 🎤 button in the dashboard are turned into text; answers can be read aloud (in Telegram only when
        you switch <code>/voice on</code> in that chat, in the dashboard with the 🔊 switch or in voice-only mode). By default answers stay text.
      </Muted>
      {usable.length === 0 && (
        <ErrorText>
          No suitable provider yet. Add one of kind <strong>OpenAI</strong> (Settings → Providers) — OpenAI itself, Groq, or a local Whisper/TTS server by its Base URL — and put its API key in.
        </ErrorText>
      )}

      <div className={styles.block}>
        <label className={styles.head}>
          <input type="checkbox" checked={d.sttOn} onChange={(e) => set({ sttOn: e.target.checked })} /> <strong>🎤 Speech recognition</strong> (voice → text)
        </label>
        {d.sttOn && (
          <>
            <Field label="Provider">{providerSelect(d.sttProvider, (v) => set({ sttProvider: v }))}</Field>
            <Field label="Model">
              <input list="stt-models" value={d.sttModel} onChange={(e) => set({ sttModel: e.target.value })} />
              <datalist id="stt-models">
                {STT_MODELS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Language of your speech">
              <select value={d.sttLang} onChange={(e) => set({ sttLang: e.target.value })}>
                {LANGS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            {d.sttProvider && <Muted>⚠ Your recordings are sent to <strong>{where(d.sttProvider)}</strong> to be recognised.</Muted>}
          </>
        )}
      </div>

      <div className={styles.block}>
        <label className={styles.head}>
          <input type="checkbox" checked={d.ttsOn} onChange={(e) => set({ ttsOn: e.target.checked })} /> <strong>🔊 Speech synthesis</strong> (text → voice)
        </label>
        {d.ttsOn && (
          <>
            <Field label="Provider">{providerSelect(d.ttsProvider, (v) => set({ ttsProvider: v }))}</Field>
            <Field label="Model">
              <input list="tts-models" value={d.ttsModel} onChange={(e) => set({ ttsModel: e.target.value })} />
              <datalist id="tts-models">
                {TTS_MODELS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Voice">
              <input list="tts-voices" value={d.ttsVoice} onChange={(e) => set({ ttsVoice: e.target.value })} />
              <datalist id="tts-voices">
                {VOICES.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Longest text to read aloud (characters; longer answers are cut at a sentence — the full text is always shown)">
              <input type="number" min={200} max={4000} step={100} value={d.ttsMax} onChange={(e) => set({ ttsMax: Number(e.target.value) || 1500 })} />
            </Field>
            {d.ttsProvider && <Muted>⚠ The text of answers that are read aloud is sent to <strong>{where(d.ttsProvider)}</strong>.</Muted>}
          </>
        )}
      </div>

      <Row wrap>
        <Button variant="primary" disabled={busy} onClick={save}>
          Save
        </Button>
        <Button disabled={busy} onClick={runTest}>
          Test (say a phrase and recognise it)
        </Button>
        {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
      </Row>
      <VoiceTryout cfg={saved} />
      {test && <pre className={styles.test}>{test}</pre>}
      <Muted>
        Costs (cloud): recognition about 0.3–0.6 ¢ per minute, speech about 1.5 ¢ per 1000 characters. Prefer everything on your own machine? Run an OpenAI-compatible
        Whisper/TTS server and give its address as the provider's Base URL — see <code>docs/voice.md</code>. The browser microphone works only on HTTPS or localhost.
      </Muted>
    </Card>
  );
}
