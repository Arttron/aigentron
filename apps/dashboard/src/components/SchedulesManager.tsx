import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeSchedule } from '@lds/shared';
import { useProjects } from '@/lib/use-projects';
import { api, errMsg, type AgentInfo, type ChannelInfo, type ScheduleInfo } from '@/lib/api';
import { DEFAULT_FORM, buildCron, parseCron, type Preset, type ScheduleFormState } from '@/lib/schedule-form';
import { Button, Card, ErrorText, Field, Modal, Muted, Row, SectionTitle } from '@/components/ui';
import styles from './SchedulesManager.module.css';
import { IntInput } from '@/components/IntInput';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays (Mon–Fri)' },
  { id: 'weekly', label: 'Certain days of the week' },
  { id: 'hours', label: 'Every N hours' },
  { id: 'custom', label: 'Custom (cron)' },
];

interface Draft {
  name: string;
  kind: 'message' | 'task' | 'script';
  text: string;
  agentName: string;
  /** script kind: minutes the script may run (as typed) */
  timeoutMin: string;
  notifyOn: 'always' | 'failure';
  /** the project a task / script runs in (slug; '' = the default project) */
  project: string;
  taskMode: 'same' | 'new';
  approvalMode: 'inherit' | 'ask' | 'off';
  channelId: string;
  chatId: string;
  timezone: string;
  quiet: boolean;
  quietStart: string;
  quietEnd: string;
  when: ScheduleFormState;
}

const localTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
const newDraft = (): Draft => ({ name: '', kind: 'message', text: '', agentName: '', timeoutMin: '10', notifyOn: 'always', project: '', taskMode: 'same', approvalMode: 'inherit', channelId: '', chatId: '', timezone: localTz(), quiet: false, quietStart: '22:00', quietEnd: '08:00', when: DEFAULT_FORM });
const fromSchedule = (s: ScheduleInfo): Draft => ({
  name: s.name,
  kind: s.kind,
  text: s.text,
  agentName: s.agentName ?? '',
  timeoutMin: s.timeoutSec ? String(Math.round((s.timeoutSec / 60) * 100) / 100) : '10',
  notifyOn: s.notifyOn ?? 'always',
  project: s.project?.slug ?? '',
  taskMode: s.taskMode ?? 'same',
  approvalMode: s.approvalMode ?? 'inherit',
  channelId: s.channelId ?? '',
  chatId: s.chatId ?? '',
  timezone: s.timezone,
  quiet: Boolean(s.quietStart),
  quietStart: s.quietStart ?? '22:00',
  quietEnd: s.quietEnd ?? '08:00',
  when: parseCron(s.cron),
});

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Schedules: reminders, recurring tasks and scripts. */
export function SchedulesManager() {
  const [items, setItems] = useState<ScheduleInfo[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { projects } = useProjects();

  const refresh = useCallback(async () => {
    try {
      const [s, c, a] = await Promise.all([api.listSchedules(), api.listChannels(), api.listAgents()]);
      setItems(s);
      setChannels(c);
      setAgents(a);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const chatsOf = useMemo(
    () => (id: string) => {
      const ch = channels.find((c) => c.id === id);
      const v = ch?.config.allowedChatIds;
      return Array.isArray(v) ? v.map(String) : [];
    },
    [channels],
  );
  const channelName = (id: string | null) => channels.find((c) => c.id === id)?.name ?? '?';

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!editing) return;
      const d = editing.draft;
      const body = {
        name: d.name.trim(),
        kind: d.kind,
        text: d.text,
        cron: buildCron(d.when),
        timezone: d.timezone.trim() || 'UTC',
        agentName: d.kind === 'task' ? d.agentName || null : null,
        taskMode: d.taskMode,
        approvalMode: d.kind === 'task' ? d.approvalMode : 'inherit',
        ...(d.kind === 'script' ? { timeoutSec: Math.max(1, Math.round((Number(d.timeoutMin) || 10) * 60)), notifyOn: d.notifyOn } : {}),
        ...(d.kind !== 'message' && (projects?.length ?? 0) > 1 ? { project: d.project || null } : {}),
        channelId: d.channelId || null,
        chatId: d.channelId ? d.chatId || chatsOf(d.channelId)[0] || null : null,
        quietStart: d.quiet ? d.quietStart : null,
        quietEnd: d.quiet ? d.quietEnd : null,
      };
      if (editing.id) await api.updateSchedule(editing.id, body);
      else await api.createSchedule(body);
      setEditing(null);
    });

  const setDraft = (patch: Partial<Draft>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  const setWhen = (patch: Partial<ScheduleFormState>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, when: { ...e.draft.when, ...patch } } } : e));
  const d = editing?.draft;
  const previewCron = d ? buildCron(d.when) : '';
  const tzs = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    } catch {
      return [];
    }
  }, []);

  return (
    <Card>
      <Row spaceBetween>
        <SectionTitle>Schedules — reminders, recurring tasks & scripts</SectionTitle>
        <Button variant="primary" onClick={() => setEditing({ id: null, draft: newDraft() })}>
          + Add schedule
        </Button>
      </Row>
      <Muted>
        A <strong>message</strong> posts text to a chat (no model, free — good for reminders). A <strong>task</strong> starts an agent on a prompt each time
        (uses model budget) and its updates arrive in the chat. A <strong>script</strong> runs a shell script on the server (no model, free; its output is kept here and can be posted to a chat). Runs missed while the server was off are skipped, not fired late.
      </Muted>
      {note && <Muted>{note}</Muted>}

      {items.length === 0 && <Muted>No schedules yet. You can also ask the admin: "remind me every day at 9 to practise English".</Muted>}
      {items.map((s) => (
        <div key={s.id} className={styles.card}>
          <div className={styles.top}>
            <strong>{s.name}</strong>
            <span className={styles.state} data-on={s.enabled}>
              {s.enabled ? 'on' : 'off'}
            </span>
          </div>
          <div className={styles.facts}>
            <span>🕒 {s.when}</span>
            {s.quietStart && <span>🌙 quiet {s.quietStart}–{s.quietEnd}</span>}
            <span>{s.kind === 'task' ? `🤖 task → ${s.agentName} (${s.taskMode === 'new' ? 'new task each time' : 'one ongoing task'}${s.approvalMode === 'off' ? ', no approvals' : ''})` : s.kind === 'script' ? `🧩 script (limit ${Math.round((s.timeoutSec ?? 600) / 60)} min${s.project ? `, project ${s.project.name}` : ''}${s.notifyOn === 'failure' ? ', chat only on failure' : ''})` : '💬 message'}</span>
            {s.channelId && (
              <span>
                → {channelName(s.channelId)} · chat {s.chatId}
              </span>
            )}
          </div>
          <div className={styles.text} style={s.kind === 'script' ? { fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' } : undefined}>{s.text}</div>
          <div className={styles.facts}>
            <span>next: {s.enabled ? fmt(s.nextRunAt) : '—'}</span>
            <span className={s.lastStatus === 'error' ? styles.bad : undefined}>
              last: {s.lastRunAt ? `${fmt(s.lastRunAt)} · ${s.lastStatus}${s.lastError ? ` (${s.lastError})` : ''}` : 'never'}
            </span>
          </div>
          {s.kind === 'script' && s.lastOutput && (
            <details style={{ margin: '6px 0' }}>
              <summary>Last output</summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 220, overflow: 'auto', margin: '6px 0' }}>{s.lastOutput}</pre>
            </details>
          )}
          <div className={styles.buttons}>
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await api.runSchedule(s.id);
                  setNote(`"${s.name}" ran now: ${r.status}${r.error ? ` — ${r.error}` : ''}`);
                })
              }
            >
              ▶ Run now
            </Button>
            <Button disabled={busy} onClick={() => run(() => api.updateSchedule(s.id, { enabled: !s.enabled }))}>
              {s.enabled ? 'Turn off' : 'Turn on'}
            </Button>
            <Button onClick={() => setEditing({ id: s.id, draft: fromSchedule(s) })}>Edit</Button>
            <Button
              variant="red"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete the schedule "${s.name}"?`)) void run(() => api.deleteSchedule(s.id));
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      ))}
      {error && <ErrorText>{error}</ErrorText>}

      {editing && d && (
        <Modal title={editing.id ? `Edit: ${d.name}` : 'New schedule'} onClose={() => setEditing(null)}>
          <Field label="Name">
            <input value={d.name} onChange={(e) => setDraft({ name: e.target.value })} placeholder="e.g. English practice" />
          </Field>
          <Field label="What happens">
            <select value={d.kind} onChange={(e) => setDraft({ kind: e.target.value as 'message' | 'task' | 'script' })}>
              <option value="message">Post a message to a chat (free)</option>
              <option value="task">Start a task for an agent (uses model budget)</option>
              <option value="script">Run a script on the server (free, no model)</option>
            </select>
          </Field>
          {d.kind === 'task' && (
            <Muted>
              Tip: if every run does the same steps (fetch data, calculate, draw a chart, post it), choose <strong>Run a script</strong> instead — no model cost and nothing for a small model to get lost in. Keep a task for work that needs judgement.
            </Muted>
          )}
          {d.kind === 'task' && /\d+[.,]\d+/.test(d.text) && (
            <Muted>
              ⚠ The prompt contains numbers like <code>{(/\d+[.,]\d+/.exec(d.text) ?? [''])[0]}</code>. A small model may copy example numbers as if they were real data (it happened with a currency report). Write examples with placeholders such as <code>&lt;rate&gt;</code>.
            </Muted>
          )}
          {d.kind === 'task' && (
            <Field label="Agent">
              <select value={d.agentName} onChange={(e) => setDraft({ agentName: e.target.value })}>
                <option value="">— choose an agent —</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {d.kind === 'task' && (
            <Field label="Each run">
              <select value={d.taskMode} onChange={(e) => setDraft({ taskMode: e.target.value as 'same' | 'new' })}>
                <option value="same">Continue ONE ongoing task (the agent remembers earlier runs) — recommended</option>
                <option value="new">Start a separate new task every time</option>
              </select>
            </Field>
          )}
          {d.kind === 'task' && (
            <Field label="Approvals for this schedule's tasks">
              <select value={d.approvalMode} onChange={(e) => setDraft({ approvalMode: e.target.value as 'inherit' | 'ask' | 'off' })}>
                <option value="inherit">Follow the project / global setting</option>
                <option value="off">No approvals — nobody is there to answer a card (a chart sent and then deleted, a report written)</option>
                <option value="ask">Ask before risky actions (the task waits for you)</option>
              </select>
              <Muted>Credentials, the charter files and the admin's platform changes are asked even then. The task's subtasks follow it.</Muted>
            </Field>
          )}
          {d.kind !== 'message' && (projects?.length ?? 0) > 1 && (
            <Field label={d.kind === 'script' ? 'Project (the script runs in its folder)' : 'Project'}>
              <select value={d.project} onChange={(e) => setDraft({ project: e.target.value })}>
                <option value="">Default project</option>
                {(projects ?? []).filter((p) => !p.isDefault && !p.archivedAt).map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={d.kind === 'task' ? 'Prompt (what the agent should do each time)' : d.kind === 'script' ? 'Script (shell)' : 'Message text'}>
            <textarea
              rows={d.kind === 'script' ? 9 : 3}
              value={d.text}
              onChange={(e) => setDraft({ text: e.target.value })}
              style={d.kind === 'script' ? { fontFamily: 'monospace', fontSize: 13 } : undefined}
              placeholder={d.kind === 'script' ? '#!/bin/sh\ncd reports && ./make-report.sh' : undefined}
              spellCheck={d.kind !== 'script'}
            />
          </Field>
          {d.kind === 'script' && (
            <>
              <Muted>
                Runs with <code>sh</code> in the project&apos;s folder, with the server&apos;s rights but a minimal environment (none of the server&apos;s keys; <code>LDS_SCHEDULE</code> holds the schedule&apos;s name). Its output (the last 4000
                characters) is kept under the schedule and, if you choose a chat below, posted there. Files the script leaves in <code>$LDS_OUTPUT_DIR</code> (a chart, a report) are sent to that chat and deleted; <code>$LDS_DATA_DIR</code> keeps files between runs (a history). A new run is skipped while the previous one is still working. Only operators can create or change a script; the admin assistant cannot.
              </Muted>
              <Row wrap>
                <Field label="Time limit (minutes)">
                  <input type="number" min={0.1} max={360} step={1} value={d.timeoutMin} onChange={(e) => setDraft({ timeoutMin: e.target.value })} style={{ maxWidth: 140 }} />
                </Field>
                <Field label="Post to the chat">
                  <select value={d.notifyOn} onChange={(e) => setDraft({ notifyOn: e.target.value as 'always' | 'failure' })}>
                    <option value="always">after every run</option>
                    <option value="failure">only when it fails</option>
                  </select>
                </Field>
              </Row>
            </>
          )}

          <Field label="When">
            <select value={d.when.preset} onChange={(e) => setWhen({ preset: e.target.value as Preset, custom: e.target.value === 'custom' ? previewCron : d.when.custom })}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          {d.when.preset !== 'custom' && d.when.preset !== 'hours' && (
            <Field label="At (24-hour time)">
              <input type="time" value={d.when.time} onChange={(e) => setWhen({ time: e.target.value || '09:00' })} />
            </Field>
          )}
          {d.when.preset === 'weekly' && (
            <div className={styles.days} role="group" aria-label="Days">
              {WEEKDAYS.map((name, n) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={d.when.days.includes(n)}
                  className={d.when.days.includes(n) ? styles.dayOn : styles.day}
                  onClick={() => setWhen({ days: d.when.days.includes(n) ? d.when.days.filter((x) => x !== n) : [...d.when.days, n] })}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          {d.when.preset === 'hours' && (
            <Row>
              <Field label="Every (hours)">
                <IntInput min={1} max={23} value={d.when.everyHours} onCommit={(n) => setWhen({ everyHours: n })} />
              </Field>
              <Field label="At minute">
                <IntInput min={0} max={59} value={Number(d.when.time.split(':')[1] ?? 0)} onCommit={(n) => setWhen({ time: `00:${String(n).padStart(2, '0')}` })} />
              </Field>
            </Row>
          )}
          {d.when.preset === 'custom' && (
            <Field label="Cron (minute hour day-of-month month day-of-week)">
              <input value={d.when.custom} onChange={(e) => setWhen({ custom: e.target.value })} placeholder="30 9 * * 1-5" />
            </Field>
          )}
          <Field label="Time zone">
            <input list="tz-list" value={d.timezone} onChange={(e) => setDraft({ timezone: e.target.value })} />
            <datalist id="tz-list">
              {tzs.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </Field>
          {previewCron && <Muted>→ {describeSchedule(previewCron, d.timezone || 'UTC')}</Muted>}

          <Field label={d.kind === 'message' ? 'Send to (required)' : d.kind === 'script' ? 'Send the result to (optional)' : 'Send updates to (optional)'}>
            <select value={d.channelId} onChange={(e) => setDraft({ channelId: e.target.value, chatId: chatsOf(e.target.value)[0] ?? '' })}>
              <option value="">{d.kind === 'message' ? '— choose a channel —' : '— nowhere (dashboard only) —'}</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {d.channelId && chatsOf(d.channelId).length > 1 && (
            <Field label="Chat">
              <select value={d.chatId} onChange={(e) => setDraft({ chatId: e.target.value })}>
                {chatsOf(d.channelId).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {d.channelId && chatsOf(d.channelId).length === 0 && <ErrorText>This channel has no allowed chats yet — add one in Settings → Channels.</ErrorText>}

          <label className={styles.check}>
            <input type="checkbox" checked={d.quiet} onChange={(e) => setDraft({ quiet: e.target.checked })} />
            <span>Quiet hours — skip runs inside this window</span>
          </label>
          {d.quiet && (
            <Row>
              <Field label="From">
                <input type="time" value={d.quietStart} onChange={(e) => setDraft({ quietStart: e.target.value })} />
              </Field>
              <Field label="To">
                <input type="time" value={d.quietEnd} onChange={(e) => setDraft({ quietEnd: e.target.value })} />
              </Field>
            </Row>
          )}

          {error && <ErrorText>{error}</ErrorText>}
          <Row>
            <Button variant="primary" disabled={busy || !d.name.trim() || !d.text.trim()} onClick={save}>
              {editing.id ? 'Save' : 'Create'}
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </Row>
        </Modal>
      )}
    </Card>
  );
}
