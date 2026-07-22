import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AttachmentMeta } from '@/lib/api';
import { Card, Row, Button, Muted, ErrorText } from '@/components/ui';
import styles from './Attachments.module.css';

/**
 * Task attachments gallery: upload image/PDF references, and view what the
 * agents read/produced. Agents see these via the Read tool (vision).
 */
export function Attachments({ taskId, reloadSignal }: { taskId: string; reloadSignal?: string }) {
  const [items, setItems] = useState<AttachmentMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    api
      .listAttachments(taskId)
      .then(setItems)
      .catch((e) => setError((e as Error).message));
  }, [taskId]);

  useEffect(() => {
    refresh();
  }, [refresh, reloadSignal]);

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await api.uploadAttachment(taskId, file);
      }
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <Card>
      <Row spaceBetween>
        <button type="button" className={styles.toggle} onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} Attachments ({items.length})
        </button>
        <Button size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'Uploading…' : '+ Upload'}
        </Button>
      </Row>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
        multiple
        className={styles.hidden}
        onChange={(e) => onPick(e.target.files)}
      />

      {open && error && <ErrorText>{error}</ErrorText>}
      {open && items.length === 0 && !error && (
        <Muted className={styles.empty}>
          Reference images/PDFs uploaded to this task, plus images agents share (e.g. screenshots).
        </Muted>
      )}

      <div className={styles.grid} hidden={!open}>
        {items.map((a) => {
          const url = api.attachmentUrl(taskId, a.name);
          return (
            <a key={a.name} href={url} target="_blank" rel="noreferrer" className={styles.tile} title={a.name}>
              {a.mime.startsWith('image/') ? (
                <img src={url} alt={a.name} className={styles.thumb} />
              ) : (
                <div className={styles.doc}>📄</div>
              )}
              <span className={styles.name}>{a.name}</span>
            </a>
          );
        })}
      </div>
    </Card>
  );
}
