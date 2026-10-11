import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { isVideo } from '@/lib/capture';
import { Modal, Button, Row, Muted, ErrorText } from '@/components/ui';
import styles from './MediaViewer.module.css';

const MAX_SIDE = 1600;

type Rect = { x: number; y: number; w: number; h: number };
const stamp = (t: number): string => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/**
 * A photo / video of a task, opened for a conversation: play it, stop on a moment (or take the photo as it is), draw a rectangle round
 * what you mean and ask — the marked picture goes to the agent as a follow-up together with where it came from (file, time).
 */
export function MediaViewer({
  taskId,
  name,
  onClose,
  onAsk,
}: {
  taskId: string;
  name: string;
  onClose: () => void;
  /** Send the follow-up (prompt + uploaded attachment names). Omitted = view only. */
  onAsk?: (prompt: string, attachments: string[]) => Promise<void>;
}) {
  const url = api.attachmentUrl(taskId, name);
  const video = isVideo(name);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const base = useRef<HTMLCanvasElement | null>(null);
  const [frame, setFrame] = useState<{ t: number | null } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redraw = useCallback((r: Rect | null) => {
    const c = canvasRef.current;
    const b = base.current;
    if (!c || !b) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(b, 0, 0);
    if (r && r.w > 3 && r.h > 3) {
      ctx.lineWidth = Math.max(3, Math.round(c.width / 220));
      ctx.strokeStyle = '#ff2d2d';
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
  }, []);

  const capture = () => {
    const el: HTMLVideoElement | HTMLImageElement | null = video ? videoRef.current : imgRef.current;
    if (!el) return;
    const sw = video ? (el as HTMLVideoElement).videoWidth : (el as HTMLImageElement).naturalWidth;
    const sh = video ? (el as HTMLVideoElement).videoHeight : (el as HTMLImageElement).naturalHeight;
    if (!sw || !sh) return;
    const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const b = document.createElement('canvas');
    b.width = Math.round(sw * k);
    b.height = Math.round(sh * k);
    b.getContext('2d')?.drawImage(el, 0, 0, b.width, b.height);
    base.current = b;
    if (video) (el as HTMLVideoElement).pause();
    setRect(null);
    setFrame({ t: video ? (el as HTMLVideoElement).currentTime : null });
  };

  // the canvas exists only after `frame` is set
  useEffect(() => {
    const c = canvasRef.current;
    const b = base.current;
    if (!frame || !c || !b) return;
    c.width = b.width;
    c.height = b.height;
    redraw(null);
  }, [frame, redraw]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = point(e);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const p = point(e);
    const r = { x: Math.min(drag.current.x, p.x), y: Math.min(drag.current.y, p.y), w: Math.abs(p.x - drag.current.x), h: Math.abs(p.y - drag.current.y) };
    setRect(r);
    redraw(r);
  };
  const onUp = () => {
    drag.current = null;
  };

  const ask = async () => {
    const c = canvasRef.current;
    if (!c || !onAsk || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.9));
      if (!blob) throw new Error('Could not take the picture.');
      const at = frame?.t != null ? `-${Math.round(frame.t * 10) / 10}s` : '-marked';
      const file = new File([blob], `${name.replace(/\.\w+$/, '')}${at}.jpg`, { type: 'image/jpeg' });
      const meta = await api.uploadAttachment(taskId, file);
      const marked = rect && rect.w > 3 && rect.h > 3;
      const where = frame?.t != null ? `the frame of the video "${name}" at ${stamp(frame.t)}` : `the photo "${name}"`;
      const prompt = `${text.trim()}\n\n(The attached picture is ${where}${marked ? '; the red rectangle marks the part I mean' : ''}.${frame?.t != null ? ` The full video is "${name}" — you can look at other moments with look_at / video_digest (at_seconds).` : ''})`;
      await onAsk(prompt, [meta.name]);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={name} onClose={onClose} wide>
      <div className={styles.stage}>
        {frame ? (
          <canvas ref={canvasRef} className={styles.canvas} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
        ) : video ? (
          <video ref={videoRef} className={styles.media} src={url} controls playsInline preload="metadata" />
        ) : (
          <img ref={imgRef} className={styles.media} src={url} alt={name} />
        )}
      </div>
      {!frame && (
        <Row wrap className={styles.bar}>
          {onAsk && (
            <Button variant="primary" onClick={capture}>
              {video ? '💬 Ask about this moment' : '💬 Mark and ask'}
            </Button>
          )}
          <a href={url} target="_blank" rel="noreferrer">
            open in a tab
          </a>
          {onAsk && video && <Muted>Pause on the moment, then press the button.</Muted>}
        </Row>
      )}
      {frame && (
        <>
          <Muted>
            {frame.t != null ? `Frame at ${stamp(frame.t)}. ` : ''}Drag on the picture to draw a rectangle round what you mean (optional).
          </Muted>
          <form
            className={styles.ask}
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What do you want to know about it?" autoFocus disabled={busy} />
            <Button variant="primary" type="submit" disabled={busy || !text.trim()}>
              {busy ? 'Sending…' : 'Ask'}
            </Button>
          </form>
          <Row wrap className={styles.bar}>
            <Button
              onClick={() => {
                setRect(null);
                redraw(null);
              }}
              disabled={!rect || busy}
            >
              Clear mark
            </Button>
            <Button onClick={() => setFrame(null)} disabled={busy}>
              ← {video ? 'Another moment' : 'Back'}
            </Button>
          </Row>
        </>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}
