'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SERVER_EVENT, type ApprovalRequest } from '@lds/shared';
import { api, type TaskListItem } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { CreateTaskForm } from '@/components/CreateTaskForm';
import { ApprovalCard } from '@/components/ApprovalCard';
import { TaskList } from '@/components/TaskList';
import { UserSwitcher } from '@/components/UserSwitcher';
import { AppHeader, Button, Card, SectionTitle, ConnStatus, ErrorText, Muted } from '@/components/ui';

const PAGE_SIZE = 25;

export default function Home() {
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshTasks = useCallback(() => {
    api
      .listTasks({ q: q.trim() || undefined, page, pageSize: PAGE_SIZE })
      .then((r) => {
        setTasks(r.items);
        setTotal(r.total);
      })
      .catch((e) => setError((e as Error).message));
  }, [q, page]);

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
            <Link href="/agents">🧑‍💻 Agents</Link>
            <Link href="/stats">📊 Stats</Link>
            <Link href="/settings">⚙ Settings</Link>
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
