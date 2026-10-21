import { useEffect, useState } from 'react';
import { useAction } from '@/lib/use-settings-resource';
import { api, type RunLimits } from '@/lib/api';
import { Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';

const FIELDS: { key: 'timeoutMin' | 'maxMin' | 'graceSec' | 'idleMin' | 'maxTurns' | 'extraMin'; label: string; min: number; max: number; hint: string }[] = [
  { key: 'timeoutMin', label: 'Run time — first window (minutes)', min: 1, max: 240, hint: 'Active time only: the clock stops while a person is asked something.' },
  { key: 'maxMin', label: 'Extended while still working, up to (minutes)', min: 1, max: 720, hint: 'When the first window runs out and the agent is still producing output it gets more time, half a window at a time, up to this. Equal to the first window = no automatic extension.' },
  { key: 'graceSec', label: '“Still working” means output within (seconds)', min: 10, max: 900, hint: 'A tool that is running (a long build or test run) counts as working for up to 10 minutes.' },
  { key: 'idleMin', label: 'Stop a silent run after (minutes, 0 = never)', min: 0, max: 120, hint: 'No output at all for this long means it is stuck.' },
  { key: 'maxTurns', label: 'Steps (model turns) per run', min: 5, max: 500, hint: 'The default for every agent that has no limit of its own (the agent form has one).' },
  { key: 'extraMin', label: 'More time per approval (minutes)', min: 5, max: 480, hint: 'What a person grants when the ceiling is reached.' },
];

/** Settings → General → Run limits: how long and how far one agent run may go, and what happens at the ceiling. */
export function RunLimitSettings() {
  const [cfg, setCfg] = useState<RunLimits | null>(null);
  const [saved, setSaved] = useState<RunLimits | null>(null);
  const [defaults, setDefaults] = useState<RunLimits | null>(null);
  const { busy, msg, setMsg, run } = useAction();

  useEffect(() => {
    void api
      .getRunLimits()
      .then((r) => {
        setCfg(r.limits);
        setSaved(r.limits);
        setDefaults(r.defaults);
      })
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);

  if (!cfg) return msg && !msg.ok ? <ErrorText>{msg.text}</ErrorText> : null;
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);

  const save = () =>
    run(async () => {
      const r = await api.saveRunLimits(cfg);
      setCfg(r.limits);
      setSaved(r.limits);
      return 'Saved — the next run uses it.';
    });
  const reset = () =>
    run(async () => {
      const r = await api.resetRunLimits();
      setCfg(r.limits);
      setSaved(r.limits);
      return 'Back to the server defaults.';
    });

  return (
    <Card>
      <SectionTitle>Run limits</SectionTitle>
      <Muted>
        How long and how far one agent run may go. A run that is still working is not cut off at the first limit; at the ceiling you can be asked whether it may go on. Applies from the next run, no restart.
      </Muted>
      {FIELDS.map((f) => (
        <Field key={f.key} label={f.label}>
          <input type="number" min={f.min} max={f.max} value={cfg[f.key]} onChange={(e) => setCfg({ ...cfg, [f.key]: Number(e.target.value) })} style={{ maxWidth: 140 }} />
          <Muted>
            {f.hint}
            {defaults ? ` Server default: ${defaults[f.key]}.` : ''}
          </Muted>
        </Field>
      ))}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
        <input type="checkbox" checked={cfg.askToExceed} onChange={(e) => setCfg({ ...cfg, askToExceed: e.target.checked })} style={{ width: 'auto', margin: 0 }} /> At the ceiling, ask me whether a run that is still working may go on
      </label>
      <Muted>Off: such a run stops at the ceiling (the task becomes stalled; the work done stays). Not answered in time counts as “no”.</Muted>
      <Row wrap>
        <Button variant={dirty ? 'primary' : undefined} disabled={busy || !dirty} onClick={save}>
          Save
        </Button>
        <Button disabled={busy} onClick={reset}>
          Reset to defaults
        </Button>
      </Row>
      {dirty && <Muted>● Not saved yet.</Muted>}
      {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
    </Card>
  );
}
