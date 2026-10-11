import { useEffect, useRef, useState } from 'react';
import { Modal, Button, Row, Muted, ErrorText } from '@/components/ui';
import styles from './CameraCapture.module.css';

type Shot = { file: File; url: string };

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

/** In-page camera: take several photos or record a clip, review them, then attach. */
export function CameraCapture({ onDone, onClose }: { onDone: (files: File[]) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [shots, setShots] = useState<Shot[]>([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 } }, audio: true })
      .catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } })) // no microphone → photos still work
      .then((s) => {
        if (dead) return s.getTracks().forEach((t) => t.stop());
        streamRef.current = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((e) => setError(`Can't open the camera: ${(e as Error).message}`));
    return () => {
      dead = true;
    };
  }, [facing]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  useEffect(() => () => shots.forEach((s) => URL.revokeObjectURL(s.url)), []);

  const add = (file: File) => setShots((s) => [...s, { file, url: URL.createObjectURL(file) }]);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    c.toBlob((b) => b && add(new File([b], `photo-${stamp()}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.9);
  };

  const toggleRecord = () => {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    const s = streamRef.current;
    if (!s || typeof MediaRecorder === 'undefined') return setError('This browser cannot record video.');
    const mime = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    rec.onstop = () => {
      const type = (rec.mimeType || 'video/webm').split(';')[0];
      add(new File(chunks.current, `clip-${stamp()}.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type }));
      setRecording(false);
    };
    rec.start(1000);
    recRef.current = rec;
    setSeconds(0);
    setRecording(true);
  };

  const finish = () => {
    onDone(shots.map((s) => s.file));
    onClose();
  };

  return (
    <Modal title="📷 Camera" onClose={onClose} wide>
      {error ? (
        <ErrorText>{error}</ErrorText>
      ) : (
        <video ref={videoRef} className={styles.preview} autoPlay playsInline muted />
      )}
      <Row wrap className={styles.bar}>
        <Button onClick={snap} disabled={recording || !!error}>
          📸 Photo
        </Button>
        <Button variant={recording ? 'red' : undefined} onClick={toggleRecord} disabled={!!error}>
          {recording ? `⏹ Stop ${seconds}s` : '🎥 Record'}
        </Button>
        <Button onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))} disabled={recording}>
          🔄 Flip
        </Button>
      </Row>
      {shots.length > 0 && (
        <div className={styles.shots}>
          {shots.map((s, i) => (
            <span key={s.url} className={styles.shot}>
              {s.file.type.startsWith('video/') ? <video src={s.url} muted /> : <img src={s.url} alt={s.file.name} />}
              <button type="button" onClick={() => setShots((x) => x.filter((_, j) => j !== i))} aria-label="Remove">
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <Row wrap className={styles.bar}>
        <Button variant="primary" onClick={finish} disabled={shots.length === 0 || recording}>
          Attach {shots.length || ''}
        </Button>
        <Muted>Several shots can go in one message.</Muted>
      </Row>
    </Modal>
  );
}
