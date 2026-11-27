import { useCallback, useEffect, useState } from 'react';
import { prepareFile } from '@/lib/capture';
import { api, type AttachmentMeta } from '@/lib/api';
import { Card, Row, UploadButton, Muted, ErrorText } from '@/components/ui';
import { MediaViewer } from './MediaViewer';
import { DocViewer } from './DocViewer';
import { docKind } from '@/lib/doc-kinds';
import styles from './Attachments.module.css';

/**
 * Task attachments gallery: upload any reference file, and view what the
 * agents read/produced. Agents view images/PDF via the Read tool's vision and
 * read text-based formats as plain text either way.
 */
export function Attachments({ taskId, reloadSignal, onAsk }: { taskId: string; reloadSignal?: string; onAsk?: (prompt: string, attachments: string[]) => Promise<void> }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [items, setItems] = useState<AttachmentMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    api
      .listAttachments(taskId)
      .then(setItems)
      .catch((e) => setError((e as Error).message));
  }, [taskId]);

  useEffect(() => {
    refresh();
  }, [refresh, reloadSignal]);

  const onPick = async (files: File[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        await api.uploadAttachment(taskId, await prepareFile(file));
      }
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (a: AttachmentMeta) => {
    if (!window.confirm(`Delete "${a.originalName ?? a.name}" from this task? Agents will no longer see it.`)) return;
    setError(null);
    try {
      await api.deleteAttachment(taskId, a.name);
      setItems((list) => list.filter((x) => x.name !== a.name));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Card>
      <Row spaceBetween>
        <button type="button" className={styles.toggle} onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} Attachments ({items.length})
        </button>
        <UploadButton size="sm" disabled={busy} onFiles={onPick}>
          {busy ? 'Uploading…' : '+ Upload'}
        </UploadButton>
      </Row>

      {open && error && <ErrorText>{error}</ErrorText>}
      {open && items.length === 0 && !error && (
        <Muted className={styles.empty}>
          Reference files uploaded to this task, plus images agents share (e.g. screenshots).
        </Muted>
      )}

      <div className={styles.grid} hidden={!open}>
        {items.map((a) => {
          const url = api.attachmentUrl(taskId, a.name);
          return (
            <div key={a.name} className={styles.cell}>
              <button type="button" className={styles.remove} title="Delete" aria-label={`Delete ${a.originalName ?? a.name}`} onClick={() => void onDelete(a)}>
                ×
              </button>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className={styles.tile}
              title={a.originalName ?? a.name}
              onClick={(e) => {
                if (docKind(a.name)) {
                  e.preventDefault();
                  setDoc(a.name);
                  return;
                }
                if (!onAsk || !(a.mime.startsWith('video/') || a.mime.startsWith('image/'))) return;
                e.preventDefault();
                setViewing(a.name);
              }}
            >
              {a.mime.startsWith('video/') ? (
                <video src={url} className={styles.thumb} preload="metadata" muted />
              ) : a.mime.startsWith('image/') ? (
                <img src={url} alt={a.originalName ?? a.name} className={styles.thumb} />
              ) : (
                <div className={styles.doc}>📄</div>
              )}
              <span className={styles.name}>{a.originalName ?? a.name}</span>
            </a>
            </div>
          );
        })}
      </div>
      {doc && <DocViewer taskId={taskId} name={doc} onClose={() => setDoc(null)} />}
      {viewing && <MediaViewer taskId={taskId} name={viewing} onClose={() => setViewing(null)} onAsk={onAsk} />}
    </Card>
  );
}
