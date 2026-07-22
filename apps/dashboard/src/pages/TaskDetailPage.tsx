import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  SERVER_EVENT,
  CLIENT_EVENT,
  isTerminalStatus,
  type AgentLogEvent,
  type TaskStatus,
} from '@lds/shared';
import { api, type TaskDetail } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { StatusBadge } from '@/components/StatusBadge';
import { ApprovalCard } from '@/components/ApprovalCard';
import { Transcript, type LogLine } from '@/components/Transcript';
import { FollowUpForm } from '@/components/FollowUpForm';
import { TaskRelations } from '@/components/TaskRelations';
import { Attachments } from '@/components/Attachments';
import {
  AppHeader,
  BackLink,
  Card,
  SectionTitle,
  Row,
  Button,
  ButtonLink,
  Muted,
  ErrorText,
} from '@/components/ui';
import styles from './TaskDetailPage.module.css';

/** Stable de-dup key — the same line can arrive via fetch and over the socket. */
const lineKey = (sessionId: string, seq: number) => `${sessionId}:${seq}`;

export function TaskDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [debug, setDebug] = useState(false);
  const [subdir, setSubdir] = useState('');
  // Bumped whenever a log line carries new attachments, so the gallery reloads
  // mid-run (agents share screenshots while the status stays 'running').
  const [assetTick, setAssetTick] = useState(0);
  const seen = useRef<Set<string>>(new Set());
  // Current task mirror, for WS handlers to read without a stale closure.
  const taskRef = useRef<TaskDetail | null>(null);

  const refreshTask = useCallback(() => {
    api
      .getTask(id)
      .then(setTask)
      .catch((e) => setError((e as Error).message));
  }, [id]);

  const addLine = useCallback((key: string, line: LogLine) => {
    if (seen.current.has(key)) return;
    seen.current.add(key);
    setLines((prev) => [...prev, line]);
  }, []);

  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  useEffect(() => {
    // Ignore late responses after unmount or an id change, so a stale fetch
    // can't overwrite the new task's state.
    let active = true;
    api
      .getTask(id)
      .then((t) => active && setTask(t))
      .catch((e) => active && setError((e as Error).message));
    api
      .getSettings()
      .then((cfg) => {
        if (!active) return;
        setDebug(cfg.debugMode);
        setSubdir(cfg.workspaceSubdir ?? '');
      })
      .catch(() => undefined);
    api
      .transcript(id)
      .then((events) => {
        if (!active) return;
        seen.current = new Set();
        const initial: LogLine[] = [];
        for (const e of events) {
          const key = lineKey(e.agentSessionId, e.seq);
          if (seen.current.has(key)) continue;
          seen.current.add(key);
          initial.push({ id: key, kind: e.kind, text: e.text, attachments: e.attachments });
        }
        setLines(initial);
      })
      .catch(() => undefined);

    const socket = getSocket();
    const subscribe = () => socket.emit(CLIENT_EVENT.subscribeTask, id);
    subscribe();
    // Re-join the per-task room after a reconnect, or live logs go silent.
    socket.on('connect', subscribe);

    const onLog = (e: AgentLogEvent) => {
      if (e.taskId !== id) return;
      const key = lineKey(e.agentSessionId, e.seq);
      addLine(key, { id: key, kind: e.kind, text: e.text, attachments: e.attachments });
      // A tool shared an image (screenshot, etc.) → refresh the gallery live.
      if (e.attachments?.length) setAssetTick((n) => n + 1);
    };
    const onStatus = (e: { taskId: string; status: TaskStatus }) => {
      if (e.taskId === id) {
        setTask((prev) => (prev ? { ...prev, status: e.status } : prev));
        refreshTask();
        return;
      }
      // A related task changed. `taskStatus` also fans out on the global room,
      // so ignore anything that isn't a subtask/parent we're showing.
      const cur = taskRef.current;
      if (!cur) return;
      const inSubs = cur.subtasks?.some((s) => s.id === e.taskId) ?? false;
      const isParent = cur.parent?.id === e.taskId;
      if (!inSubs && !isParent) return;
      // Patch the badge immediately for snappy feedback…
      setTask((prev) =>
        prev
          ? {
              ...prev,
              subtasks: prev.subtasks?.map((s) =>
                s.id === e.taskId ? { ...s, status: e.status } : s,
              ),
              parent: isParent && prev.parent ? { ...prev.parent, status: e.status } : prev.parent,
            }
          : prev,
      );
      // …then, once it settles, refetch so its summary/PR fields catch up too.
      if (isTerminalStatus(e.status)) refreshTask();
    };
    const onApproval = () => refreshTask();

    socket.on(SERVER_EVENT.agentLog, onLog);
    socket.on(SERVER_EVENT.taskStatus, onStatus);
    socket.on(SERVER_EVENT.approvalCreated, onApproval);
    socket.on(SERVER_EVENT.approvalResolved, onApproval);

    return () => {
      active = false;
      socket.emit(CLIENT_EVENT.unsubscribeTask, id);
      socket.off('connect', subscribe);
      socket.off(SERVER_EVENT.agentLog, onLog);
      socket.off(SERVER_EVENT.taskStatus, onStatus);
      socket.off(SERVER_EVENT.approvalCreated, onApproval);
      socket.off(SERVER_EVENT.approvalResolved, onApproval);
    };
  }, [id, refreshTask, addLine]);

  const cancel = async () => {
    setBusy(true);
    try {
      await api.cancelTask(id);
      refreshTask();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this task and its branch/worktree?')) return;
    setBusy(true);
    try {
      await api.deleteTask(id);
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const sendFollowUp = async (prompt: string, attachments: string[], references: string[]) => {
    await api.followUp(id, prompt, attachments, references);
    refreshTask();
  };

  const pendingApprovals = task?.approvals.filter((a) => a.status === 'pending') ?? [];
  const terminal = task ? isTerminalStatus(task.status) : false;
  // Hide verbose intermediate 'assistant' lines unless debug mode is on
  // (the final answer is already shown once as 'result').
  let visibleLines = debug ? lines : lines.filter((l) => l.kind !== 'assistant');
  // Until the run emits the opening `prompt` event, seed the request from the
  // task so the conversation always shows what was asked.
  if (task && !visibleLines.some((l) => l.kind === 'prompt')) {
    visibleLines = [{ id: 'seed-prompt', kind: 'prompt', text: task.prompt }, ...visibleLines];
  }

  return (
    <>
      <BackLink href="/">← all tasks</BackLink>

      {error && (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}

      {task && (
        <>
          <AppHeader
            clampTitle
            title={task.title}
            actions={
              <Row>
                <StatusBadge status={task.status} />
                {task.prUrl && (
                  <ButtonLink href={task.prUrl} target="_blank" rel="noreferrer">
                    Pull Request ↗
                  </ButtonLink>
                )}
                {!task.prUrl && task.pushedTo && (
                  <ButtonLink href={task.pushedTo} target="_blank" rel="noreferrer">
                    Pushed ↗
                  </ButtonLink>
                )}
                {!terminal && (
                  <Button variant="red" onClick={cancel} disabled={busy}>
                    Cancel
                  </Button>
                )}
                <Button variant="red" onClick={remove} disabled={busy} title="Delete task">
                  Delete
                </Button>
              </Row>
            }
          />

          <Muted className={styles.meta}>
            {task.agentName ?? 'default agent'} · {task.branch ?? 'no branch yet'} ·{' '}
            {task.sessions.length} session{task.sessions.length === 1 ? '' : 's'}
          </Muted>
          {task.worktreePath && (
            <Muted className={styles.meta}>
              📁 <code>{subdir ? `${task.worktreePath}/${subdir}` : task.worktreePath}</code>
            </Muted>
          )}

          <Attachments taskId={id} reloadSignal={`${task.status}:${assetTick}`} />

          <TaskRelations task={task} onChange={refreshTask} />

          {pendingApprovals.length > 0 && (
            <Card>
              <SectionTitle>Pending approvals ({pendingApprovals.length})</SectionTitle>
              {pendingApprovals.map((a) => (
                <ApprovalCard key={a.id} approval={a} />
              ))}
            </Card>
          )}

          <Card>
            <SectionTitle>Conversation</SectionTitle>
            <Transcript taskId={id} lines={visibleLines} status={task.status} terminal={terminal} />
          </Card>

          <FollowUpForm taskId={id} terminal={terminal} onSend={sendFollowUp} />
        </>
      )}
    </>
  );
}
