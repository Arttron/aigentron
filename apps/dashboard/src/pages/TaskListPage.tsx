import { useCallback, useEffect, useRef, useState } from 'react';
import { SERVER_EVENT } from '@lds/shared';
import { useProjects } from '@/lib/use-projects';
import { selectableProjects } from '@/lib/projects';
import { api, type TaskListItem, type TaskStatusFilter, type TaskTypeFilter } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { readFilterParam, withFilterParam } from '@/lib/url-filter';
import { CreateTaskForm } from '@/components/CreateTaskForm';
import { TaskList } from '@/components/TaskList';
import { AppHeader, Button, Card, SectionTitle, ConnStatus, ErrorText, Muted } from '@/components/ui';
import { BULK_LABEL, listStatus, planBulk, rangeIds, runBulk, type BulkAction } from '@/lib/bulk-actions';

const PAGE_SIZE = 25;

/** Task types for the filter chips (the server decides the type: kind > parent > origin > agent). */
const TYPES: { id: TaskTypeFilter; label: string; hint: string }[] = [
  { id: 'task', label: 'Tasks', hint: 'Started in the dashboard' },
  { id: 'chat', label: 'Chats', hint: 'Conversations with a chat agent (e.g. the admin)' },
  { id: 'channel', label: 'From chats', hint: 'Started from Telegram or another channel' },
  { id: 'scheduled', label: 'Scheduled', hint: 'Started by a schedule' },
  { id: 'discussion', label: 'Discussions', hint: 'Agents discussing among themselves' },
  { id: 'subtask', label: 'Subtasks', hint: 'Parts a lead agent split off' },
];
/** Status chips: the groups first (what is going on / what needs a person), then each status. */
const STATUSES: { id: TaskStatusFilter; label: string; hint: string }[] = [
  { id: 'attention', label: 'Needs attention', hint: 'Waiting for your approval, blocked on a question, stalled or failed' },
  { id: 'active', label: 'Active', hint: 'Queued or running (or waiting for approval)' },
  { id: 'review', label: 'Ready', hint: 'The agent has finished — waiting for you to confirm (say “done” or press Mark as done)' },
  { id: 'done', label: 'Done', hint: 'Confirmed as finished by a person' },
  { id: 'blocked', label: 'Blocked', hint: 'The agent cannot go on without you' },
  { id: 'needs_approval', label: 'Approval', hint: 'Waiting for your approval' },
  { id: 'failed', label: 'Failed', hint: 'Ended with an error' },
  { id: 'stalled', label: 'Stalled', hint: 'Ended without a status report' },
  { id: 'cancelled', label: 'Cancelled', hint: 'Stopped by a person' },
];
const STATUS_KEY = 'lds.taskStatus';
const isStatus = (v: string | null): v is TaskStatusFilter => STATUSES.some((s) => s.id === v);

function initialStatus(): TaskStatusFilter | '' {
  const fromUrl = readFilterParam(window.location.search, 'status', isStatus);
  if (fromUrl) return fromUrl;
  try {
    const saved = localStorage.getItem(STATUS_KEY);
    return isStatus(saved) ? saved : '';
  } catch {
    return '';
  }
}

const TYPE_KEY = 'lds.taskType';
const isType = (v: string | null): v is TaskTypeFilter => TYPES.some((t) => t.id === v);

function initialType(): TaskTypeFilter | '' {
  const fromUrl = readFilterParam(window.location.search, 'type', isType);
  if (fromUrl) return fromUrl;
  try {
    const saved = localStorage.getItem(TYPE_KEY);
    return isType(saved) ? saved : '';
  } catch {
    return '';
  }
}

const PROJECT_KEY = 'lds.taskProject';

function initialProject(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('project');
  if (fromUrl) return fromUrl;
  try {
    return localStorage.getItem(PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function TaskListPage() {
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [type, setType] = useState<TaskTypeFilter | ''>(initialType);
  const [status, setStatus] = useState<TaskStatusFilter | ''>(initialStatus);
  const [project, setProject] = useState<string>(initialProject);
  const { projects } = useProjects({ archived: true });
  // A remembered project that was deleted since must not leave the list empty behind a hidden filter.
  useEffect(() => {
    if (project && projects && !projects.some((x) => x.slug === project)) {
      setProject('');
      try {
        localStorage.removeItem(PROJECT_KEY);
      } catch {
        /* ignore */
      }
      window.history.replaceState(null, '', withFilterParam(window.location.href, 'project', ''));
    }
  }, [project, projects]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number> | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the newest request may write state: an older one is aborted, and a late answer is ignored.
  const inflight = useRef<AbortController | null>(null);
  const reqId = useRef(0);
  const refreshTasks = useCallback(() => {
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    const mine = ++reqId.current;
    const fresh = () => mine === reqId.current && !ctl.signal.aborted;
    api
      .listTasks({ q: q.trim() || undefined, type: type || undefined, status: status || undefined, project: project || undefined, page, pageSize: PAGE_SIZE }, ctl.signal)
      .then((r) => {
        if (!fresh()) return;
        setTasks(r.items);
        setTotal(r.total);
        setError(null);
      })
      .catch((e) => {
        if (fresh()) setError((e as Error).message);
      });
    api.taskTypeCounts(ctl.signal).then((c) => fresh() && setCounts(c)).catch(() => undefined);
    api.taskStatusCounts(type || undefined, ctl.signal).then((c) => fresh() && setStatusCounts(c)).catch(() => undefined);
  }, [q, type, status, project, page]);
  useEffect(() => () => inflight.current?.abort(), []);

  const removeTask = useCallback(
    async (id: string) => {
      if (!window.confirm('Delete this task and its branch/worktree?')) return;
      try {
        await api.deleteTask(id);
        refreshTasks();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refreshTasks],
  );

  // ---- selection mode: pick several tasks, act on them at once ----
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Map<string, { id: string; status: string }>>(new Map());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  // The row clicked last: Shift-click selects (or unselects) everything between it and the one clicked now, like a file manager.
  const lastClicked = useRef<string | null>(null);
  const toggle = (id: string, range = false) => {
    const anchor = lastClicked.current;
    lastClicked.current = id;
    setPicked((m) => {
      const next = new Map(m);
      const wanted = !m.has(id); // what the clicked row becomes; the range follows it
      const ids = range ? rangeIds(tasks.map((x) => x.id), anchor, id) : [id];
      for (const rid of ids) {
        const t = tasks.find((x) => x.id === rid);
        if (!t) continue;
        if (wanted) next.set(rid, { id: rid, status: listStatus(t) });
        else next.delete(rid);
      }
      return next;
    });
  };
  const leaveSelecting = () => {
    lastClicked.current = null;
    setSelecting(false);
    setPicked(new Map());
    setBulkMsg(null);
  };
  const allOnPage = tasks.length > 0 && tasks.every((t) => picked.has(t.id));
  const toggleAllOnPage = () =>
    setPicked((m) => {
      const next = new Map(m);
      if (allOnPage) for (const t of tasks) next.delete(t.id);
      else for (const t of tasks) next.set(t.id, { id: t.id, status: listStatus(t) });
      return next;
    });
  // The status of the picked tasks NOW (they may have moved on since they were picked); a task that is gone is dropped.
  const freshPicked = async (): Promise<{ id: string; status: string }[]> => {
    const now = new Map<string, string>();
    await runBulk([...picked.keys()], async (id) => {
      const t = await api.getTask(id);
      const byStatus: Record<string, number> = {};
      for (const sub of t.subtasks ?? []) byStatus[sub.status] = (byStatus[sub.status] ?? 0) + 1;
      now.set(id, listStatus({ status: t.status, subtasks: { byStatus } }));
    });
    return [...now].map(([id, status]) => ({ id, status }));
  };
  const bulk = async (action: BulkAction) => {
    setBulkBusy(true);
    const current = await freshPicked().catch(() => [...picked.values()]);
    setBulkBusy(false);
    const { ids, skipped: unfit } = planBulk(action, current);
    const skipped = unfit + (picked.size - current.length);
    if (!ids.length) {
      setBulkMsg(`${BULK_LABEL[action]}: nothing to do — none of the ${picked.size} selected task${picked.size === 1 ? '' : 's'} is in a state this applies to now.`);
      return;
    }
    const what = action === 'delete' ? 'Delete (with their branches / worktrees)' : action === 'cancel' ? 'Cancel' : 'Mark as done';
    const msg = `${what} ${ids.length} task${ids.length === 1 ? '' : 's'}?${skipped ? ` (${skipped} selected task${skipped === 1 ? ' does' : 's do'} not fit this action and ${skipped === 1 ? 'is' : 'are'} left alone.)` : ''}${action === 'delete' ? ' This cannot be undone.' : ''}`;
    if (!window.confirm(msg)) return;
    setBulkBusy(true);
    setBulkMsg(null);
    const fn = action === 'delete' ? (id: string) => api.deleteTask(id) : action === 'cancel' ? (id: string) => api.cancelTask(id) : (id: string) => api.markTaskDone(id);
    const r = await runBulk(ids, fn);
    setPicked((m) => {
      const next = new Map(m);
      for (const id of ids) next.delete(id);
      return next;
    });
    setBulkMsg(`${BULK_LABEL[action]}: ${r.ok} done${r.failed ? `, ${r.failed} failed (${r.errors.join('; ')})` : ''}${skipped ? `, ${skipped} skipped` : ''}.`);
    setBulkBusy(false);
    refreshTasks();
  };
  const count = (a: BulkAction) => planBulk(a, [...picked.values()]).ids.length;

  // Fetch on query/page change, debounced while typing so keystrokes don't spam
  // the server. The empty-query / page-change cases fire immediately.
  useEffect(() => {
    const t = setTimeout(refreshTasks, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [refreshTasks, q]);

  // Socket callbacks must hit the *current* view (query + page) without
  // re-subscribing on every keystroke — route them through a ref.
  const refreshRef = useRef(refreshTasks);
  refreshRef.current = refreshTasks;

  useEffect(() => {
    const socket = getSocket();
    // After a break the list may be stale: refresh once on reconnect.
    const onConnect = () => {
      setConnected(true);
      schedule();
    };
    const onDisconnect = () => setConnected(false);
    setConnected(socket.connected);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    // Agents emit status/upsert events often: coalesce a burst into one trailing refresh (≤ 1 per second).
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const schedule = () => {
      if (timer !== undefined) return;
      const wait = Math.max(0, last + 1000 - Date.now());
      timer = setTimeout(() => {
        timer = undefined;
        last = Date.now();
        refreshRef.current();
      }, wait);
    };
    const onTask = schedule;
    const onApproval = schedule;
    socket.on(SERVER_EVENT.taskUpserted, onTask);
    socket.on(SERVER_EVENT.taskStatus, onTask);
    socket.on(SERVER_EVENT.taskDeleted, onTask);
    socket.on(SERVER_EVENT.approvalCreated, onApproval);
    socket.on(SERVER_EVENT.approvalResolved, onApproval);

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off(SERVER_EVENT.taskUpserted, onTask);
      socket.off(SERVER_EVENT.taskStatus, onTask);
      socket.off(SERVER_EVENT.taskDeleted, onTask);
      socket.off(SERVER_EVENT.approvalCreated, onApproval);
      socket.off(SERVER_EVENT.approvalResolved, onApproval);
    };
  }, []);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pickStatus = (next: TaskStatusFilter | '') => {
    setStatus(next);
    setPage(1);
    try {
      if (next) localStorage.setItem(STATUS_KEY, next);
      else localStorage.removeItem(STATUS_KEY);
    } catch {
      /* not remembered */
    }
    window.history.replaceState(null, '', withFilterParam(window.location.href, 'status', next));
  };
  const pick = (next: TaskTypeFilter | '') => {
    setType(next);
    setPage(1);
    try {
      if (next) localStorage.setItem(TYPE_KEY, next);
      else localStorage.removeItem(TYPE_KEY);
    } catch {
      /* private window — the choice just is not remembered */
    }
    window.history.replaceState(null, '', withFilterParam(window.location.href, 'type', next));
  };
  const pickProject = (next: string) => {
    setProject(next);
    setPage(1);
    try {
      if (next) localStorage.setItem(PROJECT_KEY, next);
      else localStorage.removeItem(PROJECT_KEY);
    } catch {
      /* not remembered */
    }
    window.history.replaceState(null, '', withFilterParam(window.location.href, 'project', next));
  };
  const onSearch = (value: string) => {
    setQ(value);
    setPage(1); // new query always starts from the first page
  };

  return (
    <>
      <AppHeader
        title="🤖 Agent Fleet"
        actions={
          <>
            <ConnStatus connected={connected} />
          </>
        }
      />

      {error && (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}

      <CreateTaskForm onCreated={refreshTasks} projects={projects ? selectableProjects(projects) : []} />

      <Card>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            marginBottom: '0.75rem',
          }}
        >
          <SectionTitle>
            Tasks {q ? `(${total} match${total === 1 ? '' : 'es'})` : `(${total})`}
          </SectionTitle>
          <input
            type="search"
            placeholder="🔎 Search tasks…"
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            style={{ maxWidth: '18rem', marginLeft: 'auto' }}
          />
          <Button size="sm" variant={selecting ? 'primary' : undefined} aria-pressed={selecting} title="Pick several tasks and act on them at once" onClick={() => (selecting ? leaveSelecting() : setSelecting(true))}>
            {selecting ? '✓ Done selecting' : '☑ Select'}
          </Button>
        </div>
        {selecting && (
          <div role="toolbar" aria-label="Actions on the selected tasks" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <strong>{picked.size} selected</strong>
            <Muted style={{ fontSize: 11 }}>Shift-click selects a range</Muted>
            <Button size="sm" onClick={toggleAllOnPage} disabled={tasks.length === 0 || bulkBusy}>
              {allOnPage ? 'Unselect this page' : 'Select this page'}
            </Button>
            <Button size="sm" onClick={() => setPicked(new Map())} disabled={picked.size === 0 || bulkBusy}>
              Clear
            </Button>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="primary" disabled={count('done') === 0 || bulkBusy} title="Accept the finished / blocked / stalled / failed ones" onClick={() => void bulk('done')}>
              ✅ Mark as done {count('done') || ''}
            </Button>
            <Button size="sm" disabled={count('cancel') === 0 || bulkBusy} title="Stop the queued and running ones" onClick={() => void bulk('cancel')}>
              ⏹ Cancel {count('cancel') || ''}
            </Button>
            <Button size="sm" variant="red" disabled={picked.size === 0 || bulkBusy} onClick={() => void bulk('delete')}>
              🗑 Delete {picked.size || ''}
            </Button>
          </div>
        )}
        {bulkMsg && <Muted role="status" style={{ marginBottom: 8 }}>{bulkMsg}</Muted>}

        <div role="group" aria-label="Filter by status" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {[{ id: '' as const, label: 'All', hint: 'Every status' }, ...STATUSES].map((s) => {
            const n = statusCounts && s.id ? statusCounts[s.id] : undefined;
            const on = status === s.id;
            if (s.id && n === 0 && !on) return null; // only offer what exists (the selected one always stays)
            return (
              <button
                key={s.id || 'all'}
                type="button"
                title={s.hint}
                aria-pressed={on}
                onClick={() => pickStatus(s.id)}
                style={{
                  border: 'none',
                  borderRadius: 999,
                  padding: '4px 12px',
                  font: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                  background: on ? 'linear-gradient(155deg, var(--accent-strong), var(--accent))' : 'var(--bg-elev-2)',
                  color: on ? 'var(--on-accent)' : s.id === 'attention' && (n ?? 0) > 0 ? 'var(--amber)' : 'var(--text-dim)',
                  fontWeight: on || (s.id === 'attention' && (n ?? 0) > 0) ? 600 : 400,
                  boxShadow: on ? undefined : 'var(--raised-xs)',
                }}
              >
                {s.label}
                {n !== undefined && ` ${n}`}
              </button>
            );
          })}
        </div>
        <div role="group" aria-label="Filter by type" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, alignItems: 'center' }}>
          <Muted style={{ fontSize: 11 }}>Type:</Muted>
          {[{ id: '' as const, label: 'All', hint: 'Every task' }, ...TYPES].map((t) => {
            const n = counts ? (t.id ? counts[t.id] : counts.all) : undefined;
            const on = type === t.id;
            // a type with nothing in it is hidden (unless it is the one selected), so the row only offers what exists
            if (t.id && n === 0 && !on) return null;
            return (
              <button
                key={t.id || 'all'}
                type="button"
                title={t.hint}
                aria-pressed={on}
                onClick={() => pick(t.id)}
                style={{
                  border: 'none',
                  borderRadius: 999,
                  padding: '4px 12px',
                  font: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                  background: on ? 'linear-gradient(155deg, var(--accent-strong), var(--accent))' : 'var(--bg-elev-2)',
                  color: on ? 'var(--on-accent)' : 'var(--text-dim)',
                  fontWeight: on ? 600 : 400,
                  boxShadow: on ? undefined : 'var(--raised-xs)',
                }}
              >
                {t.label}
                {n !== undefined && ` ${n}`}
              </button>
            );
          })}
        </div>

        {(projects?.length ?? 0) > 1 && (
          <div role="group" aria-label="Filter by project" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, alignItems: 'center' }}>
            <Muted style={{ fontSize: 11 }}>Project:</Muted>
            {[{ slug: '', name: 'All' }, ...(projects ?? []).filter((x) => !x.archivedAt || x.slug === project)].map((x) => {
              const on = project === x.slug;
              return (
                <button
                  key={x.slug || 'all'}
                  type="button"
                  aria-pressed={on}
                  title={x.slug ? `Only tasks of ${x.name}` : 'Tasks of every project'}
                  onClick={() => pickProject(x.slug)}
                  style={{
                    border: 'none',
                    borderRadius: 999,
                    padding: '4px 12px',
                    font: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                    maxWidth: '14em',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    background: on ? 'linear-gradient(155deg, var(--accent-strong), var(--accent))' : 'var(--bg-elev-2)',
                    color: on ? 'var(--on-accent)' : 'var(--text-dim)',
                    fontWeight: on ? 600 : 400,
                    boxShadow: on ? undefined : 'var(--raised-xs)',
                  }}
                >
                  {x.name}
                </button>
              );
            })}
          </div>
        )}

        <TaskList tasks={tasks} onDelete={removeTask} selecting={selecting} selected={new Set(picked.keys())} onToggle={toggle} />

        {pageCount > 1 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.75rem',
              marginTop: '0.75rem',
            }}
          >
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              ← Prev
            </Button>
            <Muted>
              Page {page} / {pageCount}
            </Muted>
            <Button
              size="sm"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next →
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
