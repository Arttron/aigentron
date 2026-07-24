import { useEffect, useRef, useState } from 'react';
import { SERVER_EVENT, type PendingFollowUp } from '@lds/shared';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { Card, SectionTitle, Row, Button, Muted, ErrorText } from '@/components/ui';
import { cn } from '@/lib/cn';
import { TaskReferencePicker } from './TaskReferencePicker';
import styles from './FollowUpForm.module.css';

interface Staged {
  name: string;
  mime: string;
}

/** Mirrors TasksService.MAX_PENDING_FOLLOWUPS — the server is authoritative
 *  (rejects past this), this is just for a clear inline hint before that. */
const MAX_QUEUE = 3;

const IMAGE_EXT: Record<string, string> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif' };
/** The queue only stores filenames — infer a mime from the extension so a
 *  re-opened edit still shows an image thumbnail instead of the generic icon. */
function inferMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext && IMAGE_EXT[ext] ? `image/${IMAGE_EXT[ext]}` : 'application/octet-stream';
}

/**
 * Chat composer + message queue. A follow-up can only run on a settled task,
 * so while a run is in progress the message is held in the server-side
 * pending-follow-up queue (TasksService) instead — the SAME queue a channel
 * (Telegram, etc.) enqueues into, drained automatically (oldest first, one
 * per settle cycle) by the backend, not by this component. This just displays
 * the queue (live, via the followUpQueue socket event) and offers edit/remove.
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

  const [queue, setQueue] = useState<PendingFollowUp[]>([]);
  // Id of the queued message currently loaded into the composer for editing.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Load the server-side queue for this task, then keep it live via the socket
  // — a channel or another tab can enqueue/drain it just as easily as this form.
  useEffect(() => {
    let active = true;
    api
      .listPendingFollowUps(taskId)
      .then((q) => active && setQueue(q))
      .catch(() => undefined);
    const socket = getSocket();
    const onQueue = (e: { taskId: string; queue: PendingFollowUp[] }) => {
      if (e.taskId === taskId) setQueue(e.queue);
    };
    socket.on(SERVER_EVENT.followUpQueue, onQueue);
    return () => {
      active = false;
      socket.off(SERVER_EVENT.followUpQueue, onQueue);
    };
  }, [taskId]);

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
  // The server enqueues rather than 409s once terminal — this is just a clear
  // inline block before that, matching the server's own cap.
  const queueFull = !terminal && !editingId && queue.length >= MAX_QUEUE;
  const canSend = composed && !sending && !queueFull;

  const clearComposer = () => {
    setText('');
    setStaged([]);
    setReferences([]);
    setShowRefs(false);
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      if (editingId) {
        const updated = await api.updatePendingFollowUp(taskId, editingId, {
          prompt: text.trim(),
          attachments: staged.map((s) => s.name),
          references,
        });
        setQueue(updated);
        setEditingId(null);
      } else {
        await onSend(text.trim(), staged.map((s) => s.name), references);
      }
      clearComposer();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  // Editing reuses the main composer: load the message in, Save writes it back
  // in place, Cancel discards. Both exit edit mode and clear the composer.
  const startEdit = (m: PendingFollowUp) => {
    setEditingId(m.id);
    setText(m.text);
    setStaged(m.attachments.map((name) => ({ name, mime: inferMime(name) })));
    setReferences(m.references);
    setShowRefs(m.references.length > 0);
    setError(null);
  };
  const cancelEdit = () => {
    setEditingId(null);
    clearComposer();
  };

  const removeQueued = async (id: string) => {
    try {
      const updated = await api.removePendingFollowUp(taskId, id);
      setQueue(updated);
      if (editingId === id) cancelEdit();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  const onAttachKind = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const kind = e.target.value;
    e.target.value = '';
    if (kind === 'file') fileRef.current?.click();
    else if (kind === 'task') setShowRefs(true);
  };

  const primaryLabel = sending
    ? editingId
      ? 'Saving…'
      : 'Sending…'
    : editingId
      ? 'Save changes'
      : terminal
        ? 'Send'
        : `Queue${queue.length ? ` (${queue.length + 1}/${MAX_QUEUE})` : ''}`;

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
            <Button variant="primary" onClick={send} disabled={!canSend}>
              {primaryLabel}
            </Button>
            <Button onClick={cancelEdit}>Cancel</Button>
          </>
        ) : (
          <Button variant="primary" onClick={send} disabled={!canSend}>
            {primaryLabel}
          </Button>
        )}
        {editingId && <Muted className={styles.hint}>editing a queued message</Muted>}
        {!editingId && !terminal && (
          <Muted className={styles.hint}>
            run in progress — this queues and sends automatically once it finishes
          </Muted>
        )}
        {queueFull && <Muted className={styles.hint}>queue full ({MAX_QUEUE}) — edit or remove one below</Muted>}
        {error && <ErrorText>{error}</ErrorText>}
      </Row>

      {queue.length > 0 && (
        <div className={styles.queue}>
          <div className={styles.queueHead}>
            Queued ({queue.length}/{MAX_QUEUE}) — sent automatically, one per run
          </div>
          {queue.map((m, i) => {
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
                  disabled={editing}
                  onClick={() => startEdit(m)}
                >
                  ✎
                </button>
                <button type="button" className={styles.qBtn} title="Remove" onClick={() => removeQueued(m.id)}>
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
