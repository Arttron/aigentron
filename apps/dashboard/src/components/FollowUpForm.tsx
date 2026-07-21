'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Card, SectionTitle, Row, Button, Muted, ErrorText } from '@/components/ui';
import { cn } from '@/lib/cn';
import { TaskReferencePicker } from './TaskReferencePicker';
import styles from './FollowUpForm.module.css';

interface Staged {
  name: string;
  mime: string;
}

/** A message held until the task is settled enough to accept a follow-up. */
interface Queued {
  id: string;
  text: string;
  attachments: Staged[];
  references: string[];
}

const MAX_QUEUE = 3;
/** Auto-retry budget for a failed queued send; after that, a user edit/remove re-arms. */
const MAX_SEND_ATTEMPTS = 3;
const queueKey = (taskId: string) => `lds.mq.${taskId}`;
/** crypto.randomUUID is secure-context-only (undefined over plain HTTP on a LAN). */
const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Chat composer + message queue. A follow-up can only be sent to a settled task
 * (the API 409s otherwise), so while a run is in progress messages are queued
 * (up to 3) and sent automatically — one per settle cycle, since each follow-up
 * re-runs the task. Editing a queued message loads it back into the composer
 * (Save / Cancel). The queue is persisted per task in localStorage.
 */
export function FollowUpForm({
  taskId,
  terminal,
  onSend,
}: {
  taskId: string;
  terminal: boolean;
  onSend: (prompt: string, attachments: string[], references: string[]) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [staged, setStaged] = useState<Staged[]>([]);
  const [references, setReferences] = useState<string[]>([]);
  const [showRefs, setShowRefs] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [queue, setQueue] = useState<Queued[]>([]);
  const [draining, setDraining] = useState(false);
  // Id of the queued message currently loaded into the composer for editing.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Allowed to auto-send once per settled period: armed while the task is busy,
  // consumed on send, so we never fire a second follow-up before the first has
  // re-run the task (which would 409).
  const armed = useRef(true);
  // Consecutive failures sending the current head; bounds auto-retries so a
  // hard failure can't loop, while a user edit/remove resets and re-arms.
  const sendFails = useRef(0);

  // Load / persist the queue per task.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(queueKey(taskId));
      setQueue(raw ? (JSON.parse(raw) as Queued[]) : []);
    } catch {
      setQueue([]);
    }
  }, [taskId]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(queueKey(taskId), JSON.stringify(queue));
    } catch {
      /* quota / disabled storage — the queue just won't persist */
    }
  }, [taskId, queue]);

  // Auto-drain: when the task is settled, send the head. `armed` gates it to one
  // send per settle cycle (the follow-up flips `terminal` false → we re-arm).
  // Paused while an edit is open — sending a message the user is rewriting would
  // deliver the stale text and silently discard the edit.
  useEffect(() => {
    if (!terminal) {
      armed.current = true;
      sendFails.current = 0;
      return;
    }
    if (!armed.current || draining || queue.length === 0 || editingId) return;
    armed.current = false;
    const head = queue[0];
    setDraining(true);
    setError(null);
    onSend(head.text, head.attachments.map((a) => a.name), head.references)
      .then(() => {
        sendFails.current = 0;
        setQueue((q) => q.filter((m) => m.id !== head.id));
      })
      .catch((e) => {
        // Re-arm for a bounded number of auto-retries; past that the queue
        // holds (error shown) until the user edits/removes the message, which
        // re-arms. Without this a single network blip stuck the queue forever.
        sendFails.current += 1;
        if (sendFails.current < MAX_SEND_ATTEMPTS) armed.current = true;
        setError(`Queued message not sent: ${(e as Error).message}`);
      })
      .finally(() => setDraining(false));
  }, [terminal, draining, queue, editingId, onSend]);

  /** A user touched the queue — reset the failure budget and allow draining again. */
  const rearm = () => {
    sendFails.current = 0;
    armed.current = true;
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const meta = await api.uploadAttachment(taskId, file);
        setStaged((s) => [...s, { name: meta.name, mime: meta.mime }]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const composed = text.trim().length > 0 || staged.length > 0;
  // Send immediately only when the task is settled AND nothing is queued ahead;
  // otherwise everything goes through the queue so order is preserved.
  const immediate = terminal && queue.length === 0;
  const canSendNow = immediate && !sending && composed;
  const canQueue = !immediate && composed && queue.length < MAX_QUEUE;

  const clearComposer = () => {
    setText('');
    setStaged([]);
    setReferences([]);
    setShowRefs(false);
  };

  const send = async () => {
    if (!canSendNow) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text.trim(), staged.map((s) => s.name), references);
      clearComposer();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const enqueue = () => {
    if (!canQueue) return;
    setQueue((q) => [
      ...q,
      { id: newId(), text: text.trim(), attachments: staged, references },
    ]);
    rearm();
    clearComposer();
  };

  // Editing reuses the main composer: load the message in, Save writes it back
  // in place, Cancel discards. Both exit edit mode and clear the composer.
  const startEdit = (m: Queued) => {
    setEditingId(m.id);
    setText(m.text);
    setStaged(m.attachments);
    setReferences(m.references);
    setShowRefs(m.references.length > 0);
    setError(null);
  };
  const saveEdit = () => {
    if (!editingId || !composed) return;
    setQueue((q) =>
      q.map((x) =>
        x.id === editingId ? { ...x, text: text.trim(), attachments: staged, references } : x,
      ),
    );
    rearm();
    setEditingId(null);
    clearComposer();
  };
  const cancelEdit = () => {
    setEditingId(null);
    clearComposer();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (editingId) saveEdit();
      else if (immediate) void send();
      else enqueue();
    }
  };

  const onAttachKind = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const kind = e.target.value;
    e.target.value = '';
    if (kind === 'file') fileRef.current?.click();
    else if (kind === 'task') setShowRefs(true);
  };

  const primaryLabel = immediate
    ? sending
      ? 'Sending…'
      : 'Send'
    : `Queue${queue.length ? ` (${queue.length}/${MAX_QUEUE})` : ''}`;

  return (
    <Card>
      <SectionTitle className={styles.flush}>{editingId ? 'Edit queued message' : 'Message'}</SectionTitle>
      <textarea
        className={styles.input}
        placeholder="Type a message… (⌘/Ctrl+Enter) — attach images/PDFs with 📎"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
      />

      {staged.length > 0 && (
        <div className={styles.staged}>
          {staged.map((a, i) => (
            <span key={`${a.name}-${i}`} className={styles.chip}>
              {a.mime.startsWith('image/') ? (
                <img src={api.attachmentUrl(taskId, a.name)} alt={a.name} className={styles.chipThumb} />
              ) : (
                <span className={styles.chipDoc}>📄</span>
              )}
              <span className={styles.chipName}>{a.name}</span>
              <button
                type="button"
                className={styles.chipRemove}
                title="Remove from this message"
                onClick={() => setStaged((s) => s.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
        multiple
        className={styles.hidden}
        onChange={(e) => pickFiles(e.target.files)}
      />

      <Row wrap className={styles.actions}>
        <select className={styles.attachSelect} value="" onChange={onAttachKind} title="Attach" disabled={uploading}>
          <option value="">{uploading ? 'Uploading…' : '📎 Attach…'}</option>
          <option value="file">🖼 Image / file</option>
          <option value="task">🔗 Task</option>
        </select>
        {(showRefs || references.length > 0) && (
          <TaskReferencePicker value={references} onChange={setReferences} excludeId={taskId} />
        )}
        {editingId ? (
          <>
            <Button variant="primary" onClick={saveEdit} disabled={!composed}>
              Save changes
            </Button>
            <Button onClick={cancelEdit}>Cancel</Button>
          </>
        ) : (
          <Button
            variant="primary"
            onClick={immediate ? send : enqueue}
            disabled={immediate ? !canSendNow : !canQueue}
          >
            {primaryLabel}
          </Button>
        )}
        {editingId && <Muted className={styles.hint}>editing a queued message</Muted>}
        {!editingId && !terminal && (
          <Muted className={styles.hint}>
            run in progress — messages queue and send automatically when it finishes
          </Muted>
        )}
        {!editingId && !immediate && queue.length >= MAX_QUEUE && (
          <Muted className={styles.hint}>queue full ({MAX_QUEUE}) — edit or remove one below</Muted>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </Row>

      {queue.length > 0 && (
        <div className={styles.queue}>
          <div className={styles.queueHead}>
            Queued ({queue.length}/{MAX_QUEUE}) — sent automatically, one per run
            {draining && <span className={styles.draining}> · sending…</span>}
          </div>
          {queue.map((m, i) => {
            const locked = i === 0 && draining; // the head is being sent
            const editing = editingId === m.id;
            return (
              <div key={m.id} className={cn(styles.qItem, editing && styles.qEditing)}>
                <span className={styles.qNum}>{i + 1}</span>
                <span className={styles.qText}>
                  {editing ? (
                    <em>editing above…</em>
                  ) : (
                    <>
                      {m.text || <em>(no text)</em>}
                      {m.attachments.length > 0 && (
                        <span className={styles.qMeta}> · 📎 {m.attachments.length}</span>
                      )}
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className={styles.qBtn}
                  title="Edit"
                  disabled={locked || editing}
                  onClick={() => startEdit(m)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className={styles.qBtn}
                  title="Remove"
                  disabled={locked}
                  onClick={() => {
                    if (editing) cancelEdit();
                    setQueue((q) => q.filter((x) => x.id !== m.id));
                    rearm();
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
