import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  SERVER_EVENT,
  isTerminalStatus,
  type TaskStatus,
} from '@lds/shared';
import { api, type TaskDetail } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useTaskStream, type StreamEntry } from '@/lib/use-task-stream';
import { useIsPhone } from '@/lib/use-media';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/StatusBadge';
import { ProjectBadge } from '@/components/ProjectBadge';
import { ApprovalCard } from '@/components/ApprovalCard';
import { Transcript, type LogLine } from '@/components/Transcript';
import { DiscussionModal } from '@/components/DiscussionModal';
import { DiscussionBar } from '@/components/DiscussionBar';
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

/** Keyed by the route id: parent → subtask navigation remounts the page, so no state (lines, form draft, staged files) leaks between tasks. */
const CONTINUE_PROMPT = 'Continue the task from where you left off. Finish the remaining work, then report your status.';

export function TaskDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  return <TaskDetailView key={id} id={id} />;
}

const toLogLine = (e: StreamEntry): LogLine => e;

function TaskDetailView({ id }: { id: string }) {
  const navigate = useNavigate();

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [discussing, setDiscussing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [debug, setDebug] = useState(false);
  const [subdir, setSubdir] = useState('');
  // Bumped whenever a log line carries new attachments, so the gallery reloads
  // mid-run (agents share screenshots while the status stays 'running').
  const [assetTick, setAssetTick] = useState(0);
  // Does the agent's provider run through the LiteLLM gateway with a local model (Ollama)?
  const [localModel, setLocalModel] = useState(false);
  // Current task mirror, for WS handlers to read without a stale closure.
  const taskRef = useRef<TaskDetail | null>(null);

  const agentName = task?.agentName ?? null;
  useEffect(() => {
    let active = true;
    Promise.all([api.listAgents(), api.listProviders()])
      .then(([agents, providers]) => {
        const prov = agents.find((a) => a.name === agentName)?.provider;
        const kind = providers.find((p) => p.name === prov)?.kind;
        if (active) setLocalModel(kind === 'ollama');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [agentName]);

  const refreshTask = useCallback(() => {
    api
      .getTask(id)
      .then(setTask)
      .catch((e) => setError((e as Error).message));
  }, [id]);

  // History + live lines (merged by key, refetched after a reconnect).
  const { items: lines, activityAt } = useTaskStream<LogLine>(id, toLogLine, {
    // A tool shared an image (screenshot, etc.) → refresh the gallery live.
    onLive: (e) => {
      if (e.attachments?.length) setAssetTick((n) => n + 1);
    },
    onReconnect: refreshTask,
  });

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
    const socket = getSocket();

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

    socket.on(SERVER_EVENT.taskStatus, onStatus);
    socket.on(SERVER_EVENT.approvalCreated, onApproval);
    socket.on(SERVER_EVENT.approvalResolved, onApproval);
    // events are lost while the connection is: re-read the task (and its approvals) when it comes back
    socket.on('connect', onApproval);

    return () => {
      active = false;
      socket.off(SERVER_EVENT.taskStatus, onStatus);
      socket.off(SERVER_EVENT.approvalCreated, onApproval);
      socket.off(SERVER_EVENT.approvalResolved, onApproval);
      socket.off('connect', onApproval);
    };
  }, [id, refreshTask]);

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

  const markDone = async () => {
    setBusy(true);
    try {
      await api.markTaskDone(id);
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

  const resumable = ['blocked', 'stalled', 'failed'].includes(task?.status ?? '');
  const continueTask = async () => {
    setBusy(true);
    try {
      await sendFollowUp(CONTINUE_PROMPT, [], []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const phone = useIsPhone();
  const [tab, setTab] = useState<'chat' | 'files' | 'tasks'>('chat');
  const relatedCount = (task?.subtasks?.length ?? 0) + (task?.linksOut?.length ?? 0);
  // The agent's latest final answer (read aloud in voice-only mode; a new id = a new answer).
  const lastReply = useMemo(() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (l.kind === 'result' && l.text.trim()) return { id: l.id, text: l.text };
    }
    return null;
  }, [lines]);
  const pendingApprovals = task?.approvals.filter((a) => a.status === 'pending') ?? [];
  const terminal = task ? isTerminalStatus(task.status) : false;
  // Hide verbose intermediate 'assistant' lines unless debug mode is on
  // (the final answer is already shown once as 'result').
  const promptText = task?.prompt;
  const promptTs = task?.createdAt;
  const visibleLines = useMemo(() => {
    const vis = debug ? lines : lines.filter((l) => l.kind !== 'assistant' || Boolean(l.attachments?.length));
    // Until the run emits the opening `prompt` event, seed the request from the
    // task so the conversation always shows what was asked.
    if (promptText !== undefined && !vis.some((l) => l.kind === 'prompt')) {
      return [{ id: 'seed-prompt', kind: 'prompt', text: promptText, ts: promptTs }, ...vis];
    }
    return vis;
  }, [lines, debug, promptText, promptTs]);

  // Phone: an app-like shell. Header + tabs on top, the conversation fills what is left, the message box is pinned to the bottom.
  useEffect(() => {
    if (!phone || !task) return;
    document.documentElement.dataset.pinned = '1';
    return () => {
      delete document.documentElement.dataset.pinned;
    };
  }, [phone, !!task]);

  if (phone && task) {
    return (
      <div className={styles.shell}>
        <div className={styles.shellHead}>
          <BackLink href="/">←</BackLink>
          <span className={styles.shellTitle} title={task.title}>
            {task.title}
          </span>
          <StatusBadge status={task.status} />
          <details className={styles.menu}>
            <summary aria-label="Task menu">⋯</summary>
            <div className={styles.menuBody}>
              <Muted>
                {task.agentName ?? 'default agent'} · {task.branch ?? 'no branch yet'} ·{' '}
                {task.sessions.length} session
                {task.sessions.length === 1 ? '' : 's'}
              </Muted>
              {task.worktreePath && (
                <Muted>
                  📁 <code>{subdir ? `${task.worktreePath}/${subdir}` : task.worktreePath}</code>
                </Muted>
              )}
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
              {resumable && <Button onClick={continueTask} disabled={busy}>▶ Continue</Button>}
              {['review', 'blocked', 'stalled', 'failed'].includes(task.status) && <Button onClick={markDone}>✅ Mark as done</Button>}
              {terminal && <Button onClick={() => setDiscussing(true)}>💬 Discuss</Button>}
              {!terminal && (
                <Button variant="red" onClick={cancel} disabled={busy}>
                  Cancel task
                </Button>
              )}
              <Button variant="red" onClick={remove} disabled={busy}>
                Delete task
              </Button>
            </div>
          </details>
        </div>

        {error && <ErrorText>{error}</ErrorText>}

        {pendingApprovals.length > 0 && (
          <div className={styles.shellApprovals}>
            <SectionTitle>Pending approvals ({pendingApprovals.length})</SectionTitle>
            {pendingApprovals.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        )}

        <div className={styles.shellTabs}>
          <Tabs
            tabs={[
              { id: 'chat', label: 'Chat' },
              { id: 'files', label: 'Files' },
              { id: 'tasks', label: `Tasks${relatedCount ? ` (${relatedCount})` : ''}` },
            ]}
            active={tab}
            onChange={setTab}
          />
        </div>

        <div className={tab === 'chat' ? styles.paneChat : styles.paneScroll}>
          {tab === 'chat' && <DiscussionBar taskId={id} running={!terminal} />}
          {tab === 'chat' && (
            <Transcript
              taskId={id}
              lines={visibleLines}
              status={task.status}
              terminal={terminal}
              activityAt={activityAt}
              localModel={localModel}
              fill
              onAsk={(p, a) => sendFollowUp(p, a, [])}
            />
          )}
          {tab === 'files' && (
            <Attachments taskId={id} reloadSignal={`${task.status}:${assetTick}`} onAsk={(p, a) => sendFollowUp(p, a, [])} />
          )}
          {tab === 'tasks' && <TaskRelations task={task} onChange={refreshTask} />}
        </div>

        {tab === 'chat' && (
          <FollowUpForm key={id} taskId={id} terminal={terminal} onSend={sendFollowUp} lastReply={lastReply} compact />
        )}
        {/* the phone layout returns early: the discussion window has to be here as well */}
        {discussing && <DiscussionModal taskId={id} initialTopic={task.prompt} onClose={() => setDiscussing(false)} onStarted={() => refreshTask()} />}
      </div>
    );
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
                <ProjectBadge project={task.project} link />
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
                {resumable && (
                  <Button variant="primary" onClick={continueTask} disabled={busy} title="Resume the same session: the agent picks up where it stopped">
                    ▶ Continue
                  </Button>
                )}
                {['review', 'blocked', 'stalled', 'failed'].includes(task.status) && (
                  <Button variant={task.status === 'review' ? 'primary' : undefined} onClick={markDone} disabled={busy} title="Accept the result — the task becomes “done”">
                    ✅ Mark as done
                  </Button>
                )}
                {terminal && (
                  <Button onClick={() => setDiscussing(true)} title="Let several agents discuss in this chat">
                    💬 Discuss
                  </Button>
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
            <DiscussionBar taskId={id} running={!terminal} />
            <Transcript taskId={id} lines={visibleLines} status={task.status} terminal={terminal} activityAt={activityAt} localModel={localModel} onAsk={(p, a) => sendFollowUp(p, a, [])} />
          </Card>
          <FollowUpForm key={id} taskId={id} terminal={terminal} onSend={sendFollowUp} lastReply={lastReply} />

          <Attachments taskId={id} reloadSignal={`${task.status}:${assetTick}`} onAsk={(p, a) => sendFollowUp(p, a, [])} />
          <TaskRelations task={task} onChange={refreshTask} />
        </>
      )}
      {discussing && <DiscussionModal taskId={id} initialTopic={task?.prompt} onClose={() => setDiscussing(false)} onStarted={() => refreshTask()} />}
    </>
  );
}
