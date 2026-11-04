import { useEffect, useMemo, useState } from 'react';
import { COMPRESSION_RULE_LABELS, DEFAULT_COMPRESSION, compressText, normalizeCompression, validRulePattern, type CompressionConfig, type CompressionRule } from '@lds/shared';
import { useAction } from '@/lib/use-settings-resource';
import { api } from '@/lib/api';
import { Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';
import { IntInput } from '@/components/IntInput';

const NF = new Intl.NumberFormat();
const SAMPLE = `Please check the build.\n\n\n\n\nOn Mon, 3 Nov 2026 at 10:00, Bob <bob@example.com> wrote:\n> old quoted text\n> more old text\n\n2026-11-02 10:00:01 INFO step 1\n${'2026-11-02 10:00:02 INFO retrying the request\n'.repeat(60)}`;

const toggles: { key: keyof CompressionConfig; label: string; hint: string }[] = [
  { key: 'collapseWhitespace', label: 'Whitespace', hint: 'Runs of blank lines and spaces, spaces at line ends.' },
  { key: 'collapseRepeatedLines', label: 'Repeated lines', hint: 'The same line three or more times in a row becomes “line (×N)”.' },
  { key: 'stripQuotesAndSignatures', label: 'Quoted replies and signatures', hint: 'Lines starting with “>”, “On … wrote:” tails, “-- ” signatures, “Sent from my …”.' },
  { key: 'shortenBlobs', label: 'Binary blobs', hint: 'base64, data: addresses and very long hex strings become a short mark with the size.' },
  { key: 'truncateLogs', label: 'Long logs and stack traces', hint: 'A long run of log lines keeps its beginning and end; the middle becomes “… N log lines left out …”.' },
];

/** Settings → Work → Compression: the cheap, model-free filters applied to what goes to an agent (the person's messages and the answers of bulky tools). */
export function CompressionSettings() {
  const [cfg, setCfg] = useState<CompressionConfig | null>(null);
  const [saved, setSaved] = useState<CompressionConfig | null>(null);
  const [sample, setSample] = useState(SAMPLE);
  const { busy, msg, setMsg, run } = useAction();

  useEffect(() => {
    void api
      .getSettings()
      .then((s) => {
        const c = normalizeCompression(s.compression);
        setCfg(c);
        setSaved(c);
      })
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);

  const preview = useMemo(() => (cfg ? compressText(sample, { ...cfg, minChars: 0, enabled: true }) : null), [cfg, sample]);
  if (!cfg || !saved) return msg && !msg.ok ? <ErrorText>{msg.text}</ErrorText> : null;
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);
  const set = <K extends keyof CompressionConfig>(k: K, v: CompressionConfig[K]) => setCfg({ ...cfg, [k]: v });
  const setRule = (i: number, patch: Partial<CompressionRule>) => set('rules', cfg.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const badRule = cfg.rules.map((r) => (r.pattern ? validRulePattern(r.pattern, r.flags) : null));

  const save = () =>
    run(async () => {
      const r = await api.updateSettings({ compression: cfg });
      const c = normalizeCompression(r.compression);
      setCfg(c);
      setSaved(c);
      return 'Saved — the next run uses it.';
    });

  return (
    <Card>
      <SectionTitle>Compression and filtering</SectionTitle>
      <Muted>
        Cheap text filters (no model calls) cut what is sent to an agent: the noise in the person&apos;s message and in the answers of bulky tools (documents, knowledge bases, workspace files, image and video answers). Messages get every filter; tool answers (files, documents, transcripts) only the safe ones — blobs, long logs, blank lines, your rules — never quote or repeat folding. Code blocks are left alone. The
        conversation you see keeps the original; the model gets the shortened text. What each filter saved is on the Stats page.
      </Muted>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} style={{ width: 'auto', margin: 0 }} /> Compression is on
      </label>
      <Row wrap>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={cfg.applyToMessages} onChange={(e) => set('applyToMessages', e.target.checked)} style={{ width: 'auto', margin: 0 }} /> Messages to agents
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={cfg.applyToToolResults} onChange={(e) => set('applyToToolResults', e.target.checked)} style={{ width: 'auto', margin: 0 }} /> Tool answers
        </label>
      </Row>
      {toggles.map((t) => (
        <label key={t.key} style={{ display: 'block', margin: '8px 0' }}>
          <input type="checkbox" checked={cfg[t.key] as boolean} onChange={(e) => set(t.key, e.target.checked as never)} style={{ width: 'auto', margin: '0 8px 0 0' }} />
          {t.label}
          <Muted>{t.hint}</Muted>
        </label>
      ))}
      <Row wrap>
        <Field label="Log lines kept at the start">
          <IntInput min={3} max={1000} value={cfg.logKeepHead} onCommit={(n) => set('logKeepHead', n)} style={{ maxWidth: 110 }} />
        </Field>
        <Field label="…and at the end">
          <IntInput min={3} max={1000} value={cfg.logKeepTail} onCommit={(n) => set('logKeepTail', n)} style={{ maxWidth: 110 }} />
        </Field>
        <Field label="Leave texts shorter than (characters)">
          <IntInput min={0} max={100000} value={cfg.minChars} onCommit={(n) => set('minChars', n)} style={{ maxWidth: 130 }} />
        </Field>
        <Field label="Cut one text to (characters, 0 = no limit)">
          <IntInput min={0} max={100000000} value={cfg.maxChars} onCommit={(n) => set('maxChars', n)} style={{ maxWidth: 150 }} />
        </Field>
      </Row>
      <Muted>The cut keeps the beginning and the end and says how much was left out. Use it with care: it can remove something the agent needs.</Muted>

      <div style={{ marginTop: 20 }}>
        <SectionTitle>Your own rules</SectionTitle>
      </div>
      <Muted>Regular expressions applied last, for example a ticket footer or a banner that is always the same. Replace with nothing to remove.</Muted>
      {cfg.rules.map((r, i) => (
        <div key={i} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: 12, marginBottom: 12, border: '1px solid rgba(128,128,128,.28)', borderRadius: 10 }}>
          <input placeholder="name" value={r.name} onChange={(e) => setRule(i, { name: e.target.value })} style={{ flex: '0 1 150px', width: 'auto', minWidth: 110 }} />
          <input placeholder="pattern, e.g. ^Confidential.*$" value={r.pattern} onChange={(e) => setRule(i, { pattern: e.target.value })} style={{ flex: '2 1 240px', width: 'auto', minWidth: 160 }} />
          <input placeholder="replace with" value={r.replace} onChange={(e) => setRule(i, { replace: e.target.value })} style={{ flex: '1 1 160px', width: 'auto', minWidth: 120 }} />
          <input placeholder="flags (i m s)" value={r.flags ?? ''} onChange={(e) => setRule(i, { flags: e.target.value.replace(/[^gimsu]/g, '') })} style={{ flex: '0 0 110px', width: 'auto' }} />
          <Button size="sm" onClick={() => set('rules', cfg.rules.filter((_, j) => j !== i))}>
            Remove
          </Button>
          {badRule[i] && <div style={{ flexBasis: '100%' }}><ErrorText>{badRule[i]}</ErrorText></div>}
        </div>
      ))}
      <div style={{ marginTop: 14 }}>
        <Button size="sm" onClick={() => set('rules', [...cfg.rules, { name: `rule ${cfg.rules.length + 1}`, pattern: '', replace: '' }])}>
          + Add a rule
        </Button>
      </div>

      <div style={{ marginTop: 20 }}>
        <SectionTitle>Try it</SectionTitle>
      </div>
      <Muted>Paste a text to see what these settings would do to it (nothing is saved or sent).</Muted>
      <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={7} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} />
      {preview && (
        <>
          <Muted>
            {NF.format(preview.before)} → {NF.format(preview.after)} characters
            {preview.before > 0 ? ` (−${Math.round(((preview.before - preview.after) / preview.before) * 100)}%, ≈ ${NF.format(Math.round((preview.before - preview.after) / 4))} tokens)` : ''}
            {Object.entries(preview.saved).length
              ? ` — ${Object.entries(preview.saved)
                  .map(([k, v]) => `${COMPRESSION_RULE_LABELS[k] ?? k.replace(/^rule:/, '')}: ${NF.format(v)}`)
                  .join(', ')}`
              : ''}
          </Muted>
          <textarea readOnly value={preview.text} rows={7} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} />
        </>
      )}

      <div style={{ marginTop: 16 }} />
      <Row wrap>
        <Button variant={dirty ? 'primary' : undefined} disabled={busy || !dirty || badRule.some(Boolean)} onClick={save}>
          Save
        </Button>
        <Button disabled={busy} onClick={() => setCfg({ ...DEFAULT_COMPRESSION })}>
          Reset to defaults
        </Button>
      </Row>
      {dirty && <Muted>● Not saved yet.</Muted>}
      {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
    </Card>
  );
}
