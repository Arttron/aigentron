import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SERVER_EVENT, CLIENT_EVENT, type AgentLogEvent, type TaskStatus } from '@lds/shared';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import type { StateName } from '@/lib/mascot';
import { MascotView } from './MascotView';
import styles from './AdminChat.module.css';

const ADMIN = 'admin';
const STORAGE_KEY = 'lds.adminChatTaskId';

interface Msg {
  id: string;
  from: 'me' | 'admin';
  text: string;
}

const lineKey = (sessionId: string, seq: number) => `${sessionId}:${seq}`;

function readId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — the chat just isn't restored on reload */
  }
}

/** Only the user's messages and the admin's final replies are chat; tool noise stays out. */
function toMsg(kind: string, text: string, id: string): Msg | null {
  if (!text.trim()) return null;
  if (kind === 'prompt') return { id, from: 'me', text };
  if (kind === 'result') return { id, from: 'admin', text };
  return null;
}

/**
 * Support-style chat with the built-in admin agent: a bubble in the corner of every page.
 * Under the hood it is one long-lived chat-mode task assigned to `admin`; each user message
 * is a follow-up that resumes the same agent session. Change proposals show up as approval
 * cards (the global approval dock) with the full content.
 */
export function AdminChat() {
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(() => readId());
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerIssue, setProviderIssue] = useState<string | null>(null);
  // Platform-wide activity (any task), so the mascot reacts to tasks while the chat is closed.
  const [activeTasks, setActiveTasks] = useState<Set<string>>(new Set());
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [flash, setFlash] = useState<'success' | 'error' | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const openRef = useRef(false);
  const taskIdRef = useRef<string | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  const push = useCallback((m: Msg) => {
    if (seen.current.has(m.id)) return;
    seen.current.add(m.id);
    setMsgs((prev) => [...prev, m]);
  }, []);

  // Load history + live updates for the current chat task.
  useEffect(() => {
    if (!taskId) {
      setMsgs([]);
      setStatus(null);
      seen.current = new Set();
      return;
    }
    let live = true;
    api
      .getTask(taskId)
      .then((t) => {
        if (!live) return;
        if (t.agentName !== ADMIN) throw new Error('not an admin chat');
        setStatus(t.status);
      })
      .catch((e: Error) => {
        if (!live) return;
        // Only a deleted task / foreign id is a reason to forget the chat; a network blip or restart is not.
        if (/404|not found|not an admin chat/i.test(e.message)) {
          writeId(null);
          setTaskId(null);
        } else {
          setError(`Could not load the chat (${e.message}) — it is kept, reload to retry.`);
        }
      });
    api
      .transcript(taskId)
      .then((events) => {
        if (!live) return;
        seen.current = new Set();
        const initial: Msg[] = [];
        for (const e of events) {
          const id = lineKey(e.agentSessionId, e.seq);
          const m = toMsg(e.kind, e.text, id);
          if (m && !seen.current.has(id)) {
            seen.current.add(id);
            initial.push(m);
          }
        }
        setMsgs(initial);
      })
      .catch(() => undefined);

    const socket = getSocket();
    const subscribe = () => socket.emit(CLIENT_EVENT.subscribeTask, taskId);
    subscribe();
    socket.on('connect', subscribe);
    const onLog = (e: AgentLogEvent) => {
      if (e.taskId !== taskId) return;
      const m = toMsg(e.kind, e.text, lineKey(e.agentSessionId, e.seq));
      if (m) push(m);
    };
    const onStatus = (e: { taskId: string; status: TaskStatus }) => {
      if (e.taskId === taskId) setStatus(e.status);
    };
    socket.on(SERVER_EVENT.agentLog, onLog);
    socket.on(SERVER_EVENT.taskStatus, onStatus);
    return () => {
      live = false;
      socket.emit(CLIENT_EVENT.unsubscribeTask, taskId);
      socket.off('connect', subscribe);
      socket.off(SERVER_EVENT.agentLog, onLog);
      socket.off(SERVER_EVENT.taskStatus, onStatus);
    };
  }, [taskId, push]);

  // Before the first message: is the default provider actually able to answer?
  useEffect(() => {
    if (!open || taskId) return;
    let live = true;
    Promise.all([api.getSettings().catch(() => null), api.listProviders().catch(() => [])]).then(
      ([settings, providers]) => {
        if (!live) return;
        const name = settings?.defaultProvider;
        const p = providers.find((x) => x.name === name);
        if (!name || !p) setProviderIssue('No default provider is configured.');
        else if (!p.model) setProviderIssue(`Provider "${p.name}" has no default model.`);
        else if (!p.secretSet && p.kind !== 'ollama' && p.authMode !== 'codex-login') setProviderIssue(`Provider "${p.name}" has no API key/token.`);
        else setProviderIssue(null);
      },
    );
    return () => {
      live = false;
    };
  }, [open, taskId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs, status, open]);

  const working = status === 'running' || status === 'queued';

  const waitingApproval = status === 'needs_approval';
  openRef.current = open;
  taskIdRef.current = taskId;

  // Watch every task + approval platform-wide: with the chat closed the mascot reflects the whole fleet.
  useEffect(() => {
    let live = true;
    api
      .listTasks({ pageSize: 100 })
      .then((p) => {
        if (!live) return;
        setActiveTasks(new Set(p.items.filter((t) => t.status === 'running' || t.status === 'queued').map((t) => t.id)));
      })
      .catch(() => undefined);
    api
      .listApprovals('pending')
      .then((a) => live && setPendingApprovals(a.length))
      .catch(() => undefined);

    const socket = getSocket();
    const react = (kind: 'success' | 'error') => {
      setFlash(kind);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), 2200); // = the one-shot's length (60 frames @ 30fps)
    };
    const onStatus = (e: { taskId: string; status: TaskStatus }) => {
      setActiveTasks((prev) => {
        const next = new Set(prev);
        if (e.status === 'running' || e.status === 'queued') next.add(e.taskId);
        else next.delete(e.taskId);
        return next;
      });
      // Open: only this chat's task triggers a reaction. Closed: any task does.
      // `blocked` is a hand-off to a human, not a failure, so it doesn't count as an error.
      const relevant = !openRef.current || e.taskId === taskIdRef.current;
      if (relevant && e.status === 'done') react('success');
      else if (relevant && (e.status === 'failed' || e.status === 'stalled')) react('error');
    };
    const onApprovalCreated = () => setPendingApprovals((n) => n + 1);
    const onApprovalResolved = () => setPendingApprovals((n) => Math.max(0, n - 1));
    socket.on(SERVER_EVENT.taskStatus, onStatus);
    socket.on(SERVER_EVENT.approvalCreated, onApprovalCreated);
    socket.on(SERVER_EVENT.approvalResolved, onApprovalResolved);
    return () => {
      live = false;
      window.clearTimeout(flashTimer.current);
      socket.off(SERVER_EVENT.taskStatus, onStatus);
      socket.off(SERVER_EVENT.approvalCreated, onApprovalCreated);
      socket.off(SERVER_EVENT.approvalResolved, onApprovalResolved);
    };
  }, []);

  // Mascot mood. Open: follows this chat. Closed: follows the fleet. A just-finished task/reply is a
  // one-shot `success`; the controller resumes the base mood when it ends (requests queue until then).
  const busy = open ? working : activeTasks.size > 0;
  const base: StateName = busy ? 'thinking' : 'idle';
  const mood: StateName = flash ?? base;
  // Visual accent around the mascot — the animation's own differences between states are subtle at small sizes.
  const accent = flash ? flash : open ? (waitingApproval ? 'waiting' : working ? 'busy' : 'idle') : pendingApprovals > 0 ? 'waiting' : busy ? 'busy' : 'idle';

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      if (!taskId) {
        const t = await api.createTask({ prompt: body, title: 'Chat with admin', agentName: ADMIN, autostart: true });
        writeId(t.id);
        setTaskId(t.id);
      } else {
        await api.followUp(taskId, body);
      }
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const newChat = () => {
    writeId(null);
    setTaskId(null);
    setError(null);
  };

  const failed = status === 'failed';

  // Let the approval dock step aside while the panel occupies the bottom-right corner.
  useEffect(() => {
    document.body.classList.toggle('admin-chat-open', open);
    return () => document.body.classList.remove('admin-chat-open');
  }, [open]);

  return (
    <>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="Chat with admin">
          <div className={styles.head}>
            <div className={styles.headMascot} data-accent={accent}>
              <MascotView state={mood} size={76} />
            </div>
            <strong>Admin</strong>
            <span className={styles.sub}>agent assistant</span>
            <span className={styles.spacer} />
            {taskId && (
              <>
                <Link className={styles.headBtn} to={`/tasks/${taskId}`} onClick={() => setOpen(false)} title="Open as a task">
                  ↗
                </Link>
                <button className={styles.headBtn} onClick={newChat} title="Start a new chat">
                  ＋
                </button>
              </>
            )}
            <button className={styles.headBtn} onClick={() => setOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>

          <div className={styles.body}>
            {msgs.length === 0 && (
              <div className={styles.hint}>
                Hi! I can help you set up agents — describe what you want to get done and I&rsquo;ll suggest
                and create the right agents for it. Every change is shown to you for approval first.
              </div>
            )}
            {providerIssue && !taskId && (
              <div className={styles.warn}>
                ⚠ {providerIssue} I answer using the default provider —{' '}
                <Link to="/settings" onClick={() => setOpen(false)}>
                  configure it in Settings
                </Link>
                .
              </div>
            )}
            {msgs.map((m) => (
              <div key={m.id} className={m.from === 'me' ? styles.me : styles.admin}>
                {m.text}
              </div>
            ))}
            {working && <div className={styles.typing}>Admin is typing…</div>}
            {waitingApproval && (
              <div className={styles.typing}>Waiting for your approval — see the card at the bottom right.</div>
            )}
            {failed && (
              <div className={styles.warn}>
                The last reply failed. Check the provider in Settings, then send your message again.
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className={styles.composer}>
            <textarea
              className={styles.input}
              rows={2}
              value={text}
              placeholder="Write a message…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={sending}
            />
            <button className={styles.send} onClick={() => void send()} disabled={sending || !text.trim()}>
              ➤
            </button>
          </div>
          {error && <div className={styles.error}>{error}</div>}
        </div>
      )}
      {/* Closed: the mascot IS the launcher. Open: it lives in the panel header instead (no ✕ in its place). */}
      {!open && (
        <button
          className={styles.bubble}
          onClick={() => setOpen(true)}
          aria-label="Chat with admin"
          title="Chat with admin"
        >
          <div className={styles.bubbleRing} data-accent={accent}>
            <MascotView state={mood} size={100} />
          </div>
          {pendingApprovals > 0 && <span className={styles.dot} />}
        </button>
      )}
    </>
  );
}
