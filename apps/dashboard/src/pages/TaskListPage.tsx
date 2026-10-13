import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SERVER_EVENT, type ApprovalRequest } from '@lds/shared';
import { api, type TaskListItem, type TaskStatusFilter, type TaskTypeFilter } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { CreateTaskForm } from '@/components/CreateTaskForm';
import { ApprovalCard } from '@/components/ApprovalCard';
import { TaskList } from '@/components/TaskList';
import { UserSwitcher } from '@/components/UserSwitcher';
import { AppHeader, Button, Card, SectionTitle, ConnStatus, ErrorText, Muted } from '@/components/ui';

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
  const fromUrl = new URLSearchParams(window.location.search).get('status');
  if (isStatus(fromUrl)) return fromUrl;
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
  const fromUrl = new URLSearchParams(window.location.search).get('type');
  if (isType(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem(TYPE_KEY);
    return isType(saved) ? saved : '';
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
  const [statusCounts, setStatusCounts] = useState<Record<string, number> | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshTasks = useCallback(() => {
    api
      .listTasks({ q: q.trim() || undefined, type: type || undefined, status: status || undefined, page, pageSize: PAGE_SIZE })
      .then((r) => {
        setTasks(r.items);
        setTotal(r.total);
      })
      .catch((e) => setError((e as Error).message));
    api.taskTypeCounts().then(setCounts).catch(() => undefined);
    api.taskStatusCounts(type || undefined).then(setStatusCounts).catch(() => undefined);
  }, [q, type, status, page]);

  const refreshApprovals = useCallback(() => {
    api
      .listApprovals('pending')
      .then(setApprovals)
      .catch(() => undefined);
  }, []);

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
    refreshApprovals();

    const socket = getSocket();
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    setConnected(socket.connected);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    const onTask = () => refreshRef.current();
    const onApproval = () => {
      refreshRef.current();
      refreshApprovals();
    };
    socket.on(SERVER_EVENT.taskUpserted, onTask);
    socket.on(SERVER_EVENT.taskStatus, onTask);
    socket.on(SERVER_EVENT.taskDeleted, onTask);
    socket.on(SERVER_EVENT.approvalCreated, onApproval);
    socket.on(SERVER_EVENT.approvalResolved, onApproval);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off(SERVER_EVENT.taskUpserted, onTask);
      socket.off(SERVER_EVENT.taskStatus, onTask);
      socket.off(SERVER_EVENT.taskDeleted, onTask);
      socket.off(SERVER_EVENT.approvalCreated, onApproval);
      socket.off(SERVER_EVENT.approvalResolved, onApproval);
    };
  }, [refreshApprovals]);

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
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('status', next);
    else url.searchParams.delete('status');
    window.history.replaceState(null, '', url);
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
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('type', next);
    else url.searchParams.delete('type');
    window.history.replaceState(null, '', url);
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
            <UserSwitcher />
            <ConnStatus connected={connected} />
            <Link to="/agents">🧑‍💻 Agents</Link>
            <Link to="/resources">📚 Resources</Link>
            <Link to="/knowledge">🧠 Knowledge</Link>
            <Link to="/workspace">📁 Workspace</Link>
            <Link to="/stats">📊 Stats</Link>
            <Link to="/settings">⚙ Settings</Link>
          </>
        }
      />

      {error && (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}

      <CreateTaskForm onCreated={refreshTasks} />

      {approvals.length > 0 && (
        <Card>
          <SectionTitle>Pending approvals ({approvals.length})</SectionTitle>
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} showTask />
          ))}
        </Card>
      )}

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
        </div>

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

        <TaskList tasks={tasks} onDelete={removeTask} />

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
