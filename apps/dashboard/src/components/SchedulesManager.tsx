import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeSchedule } from '@lds/shared';
import { api, type AgentInfo, type ChannelInfo, type ScheduleInfo } from '@/lib/api';
import { DEFAULT_FORM, buildCron, parseCron, type Preset, type ScheduleFormState } from '@/lib/schedule-form';
import { Button, Card, ErrorText, Field, Modal, Muted, Row, SectionTitle } from '@/components/ui';
import styles from './SchedulesManager.module.css';

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
  kind: 'message' | 'task';
  text: string;
  agentName: string;
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
const newDraft = (): Draft => ({ name: '', kind: 'message', text: '', agentName: '', channelId: '', chatId: '', timezone: localTz(), quiet: false, quietStart: '22:00', quietEnd: '08:00', when: DEFAULT_FORM });
const fromSchedule = (s: ScheduleInfo): Draft => ({
  name: s.name,
  kind: s.kind,
  text: s.text,
  agentName: s.agentName ?? '',
  channelId: s.channelId ?? '',
  chatId: s.chatId ?? '',
  timezone: s.timezone,
  quiet: Boolean(s.quietStart),
  quietStart: s.quietStart ?? '22:00',
  quietEnd: s.quietEnd ?? '08:00',
  when: parseCron(s.cron),
});

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Settings → Schedules: reminders and recurring tasks. */
export function SchedulesManager() {
  const [items, setItems] = useState<ScheduleInfo[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
      setError((e as Error).message.replace(/^\d+ [^—]*— /, ''));
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
        <SectionTitle>Schedules — reminders & recurring tasks</SectionTitle>
        <Button variant="primary" onClick={() => setEditing({ id: null, draft: newDraft() })}>
          + Add schedule
        </Button>
      </Row>
      <Muted>
        A <strong>message</strong> posts text to a chat (no model, free — good for reminders). A <strong>task</strong> starts an agent on a prompt each time
        (uses model budget) and its updates arrive in the chat. Runs missed while the server was off are skipped, not fired late.
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
            <span>{s.kind === 'task' ? `🤖 task → ${s.agentName}` : '💬 message'}</span>
            {s.channelId && (
              <span>
                → {channelName(s.channelId)} · chat {s.chatId}
              </span>
            )}
          </div>
          <div className={styles.text}>{s.text}</div>
          <div className={styles.facts}>
            <span>next: {s.enabled ? fmt(s.nextRunAt) : '—'}</span>
            <span className={s.lastStatus === 'error' ? styles.bad : undefined}>
              last: {s.lastRunAt ? `${fmt(s.lastRunAt)} · ${s.lastStatus}${s.lastError ? ` (${s.lastError})` : ''}` : 'never'}
            </span>
          </div>
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
            <select value={d.kind} onChange={(e) => setDraft({ kind: e.target.value as 'message' | 'task' })}>
              <option value="message">Post a message to a chat (free)</option>
              <option value="task">Start a task for an agent (uses model budget)</option>
            </select>
          </Field>
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
          <Field label={d.kind === 'task' ? 'Prompt (what the agent should do each time)' : 'Message text'}>
            <textarea rows={3} value={d.text} onChange={(e) => setDraft({ text: e.target.value })} />
          </Field>

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
                <input type="number" min={1} max={23} value={d.when.everyHours} onChange={(e) => setWhen({ everyHours: Number(e.target.value) || 1 })} />
              </Field>
              <Field label="At minute">
                <input type="number" min={0} max={59} value={Number(d.when.time.split(':')[1] ?? 0)} onChange={(e) => setWhen({ time: `00:${String(Math.min(59, Math.max(0, Number(e.target.value) || 0))).padStart(2, '0')}` })} />
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

          <Field label={d.kind === 'message' ? 'Send to (required)' : 'Send updates to (optional)'}>
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
