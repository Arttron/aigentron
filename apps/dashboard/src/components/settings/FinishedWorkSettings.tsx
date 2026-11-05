import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type FinishedWorkLogEntry, type FinishedWorkPlan, type Settings } from '@/lib/api';
import { formatBytes } from '@/lib/format-bytes';
import { useAction } from '@/lib/use-settings-resource';
import { IntInput } from '@/components/IntInput';
import { Badge, Button, Card, ErrorText, Field, Muted, Row, SectionTitle } from '@/components/ui';

type Mode = NonNullable<Settings['cleanupMode']>;

const MODES: { value: Mode; label: string }[] = [
  { value: 'merged_or_done', label: 'When merged, or a few days after the task is done' },
  { value: 'merged', label: 'Only when its work is merged' },
  { value: 'off', label: 'Never (keep every checkout)' },
];

const when = (iso: string) => new Date(iso).toLocaleString();

/** Settings → Maintenance → Finished work: a task's own copy of the repository is cleared once its work is merged or done — never when work would be lost. */
export function FinishedWorkSettings() {
  const [mode, setMode] = useState<Mode>('merged_or_done');
  const [days, setDays] = useState(3);
  const [saved, setSaved] = useState<{ mode: Mode; days: number } | null>(null);
  const [plan, setPlan] = useState<FinishedWorkPlan | null>(null);
  const [log, setLog] = useState<FinishedWorkLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { busy, msg, setMsg, run } = useAction();

  const load = useCallback(() => {
    void api.getSettings().then((s) => {
      const m = (s.cleanupMode ?? 'merged_or_done') as Mode;
      setMode(m);
      setDays(s.cleanupDoneDays ?? 3);
      setSaved({ mode: m, days: s.cleanupDoneDays ?? 3 });
    }).catch((e: Error) => setError(e.message));
    void api.finishedWorkLog().then(setLog).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const dirty = saved !== null && (saved.mode !== mode || saved.days !== days);
  const save = () =>
    run(async () => {
      const s = await api.updateSettings({ cleanupMode: mode, cleanupDoneDays: days });
      setSaved({ mode: (s.cleanupMode ?? mode) as Mode, days: s.cleanupDoneDays ?? days });
      setPlan(null);
      return 'Saved.';
    });

  const preview = () =>
    run(async () => {
      const p = await api.finishedWork();
      setPlan(p);
      return p.willRemove ? `${p.willRemove} checkout(s) would be cleared.` : 'Nothing would be cleared right now.';
    });

  const clearNow = () => {
    if (!plan || !window.confirm(`Clear ${plan.willRemove} checkout(s) now (${formatBytes(plan.willFree)})? Only what the list marks as "will be cleared" goes; nothing with unsaved work.`)) return;
    void run(async () => {
      const r = await api.runFinishedWork();
      setPlan(await api.finishedWork());
      setLog(await api.finishedWorkLog());
      return r.removed ? `Cleared ${r.removed} checkout(s), ${formatBytes(r.freed)} freed.` : 'Nothing was cleared (the situation changed since the list was made).';
    });
  };

  return (
    <Card>
      <SectionTitle>Finished work — task checkouts</SectionTitle>
      <Muted>
        Every task works in its own copy of the repository. When the work is merged into the main branch, or the task has been done for a few days, that copy is cleared to free space. It is
        <strong> never</strong> cleared while it holds uncommitted files, or commits that exist nowhere else (not merged, not pushed), or while the task is running. A message to a cleared
        task brings its copy back from its branch. Checked every 6 hours.
      </Muted>
      {error && <ErrorText>{error}</ErrorText>}
      <Field label="Clear a task's checkout">
        <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      {mode === 'merged_or_done' && (
        <Field label="Days to wait after a task is done or cancelled (when its work is not merged but saved on the remote)">
          <IntInput min={1} max={365} value={days} onCommit={setDays} />
        </Field>
      )}
      <Row wrap>
        <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
          Save
        </Button>
        <Button disabled={busy || dirty} onClick={() => void preview()} title={dirty ? 'Save the setting first' : undefined}>
          Show what would be cleared
        </Button>
        {plan && plan.willRemove > 0 && (
          <Button disabled={busy} onClick={clearNow}>
            Clear now ({plan.willRemove} · {formatBytes(plan.willFree)})
          </Button>
        )}
      </Row>
      {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}

      {plan && (
        <div style={{ marginTop: 8 }}>
          <Muted>
            {plan.items.length === 0
              ? 'No task has a checkout of its own right now.'
              : `${plan.items.length} checkout(s); ${plan.willRemove} would be cleared (${formatBytes(plan.willFree)}).`}
          </Muted>
          <ul style={{ margin: '6px 0', paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
            {plan.items.map((i) => (
              <li key={i.path} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 13 }}>
                <Badge tone={i.decision.remove ? 'done' : 'neutral'}>{i.decision.remove ? 'will be cleared' : 'kept'}</Badge>
                <Link to={`/tasks/${i.taskId}`}>{i.title || i.taskId}</Link>
                <span style={{ opacity: 0.7 }}>
                  {i.status} · {i.decision.reason}
                  {i.decision.remove && i.bytes !== null ? ` · ${formatBytes(i.bytes)}` : ''}
                  {i.decision.remove && i.decision.deleteBranch ? ' · its branch goes too' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {log.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>Cleared lately ({log.length})</summary>
          <ul style={{ margin: '6px 0', paddingLeft: 18, fontSize: 13 }}>
            {log.slice(0, 20).map((e) => (
              <li key={`${e.at}-${e.taskId}`}>
                {when(e.at)} — <Link to={`/tasks/${e.taskId}`}>{e.title || e.taskId}</Link>: {formatBytes(e.bytes)} freed ({e.reason}
                {e.branchDeleted ? '; branch deleted' : ''})
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
