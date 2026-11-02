// Dictation: a microphone button next to a text box. A recording goes to the server (Settings → Voice: OpenAI, Groq, the local voice add-on, VoiceLab …) and the text lands in the box.
import { apiFetch } from './api.js';

let sttReady = null;
/** Is speech recognition set up on the server? (asked once per page) */
export async function micAvailable() {
  if (sttReady === null) sttReady = await apiFetch('/api/voice').then((v) => Boolean(v?.sttReady)).catch(() => false);
  return sttReady;
}

const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

/** A 🎤 button for `textarea`; resolves to null when recognition is not set up. `onNeedPermission()` is called when the browser refuses the microphone. */
export async function micButton(textarea, { onNeedPermission } = {}) {
  if (!(await micAvailable())) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '🎤';
  btn.title = 'Dictate';
  let rec = null;
  let chunks = [];
  const status = (t) => (btn.title = t);

  async function stop() {
    if (!rec) return;
    const r = rec;
    rec = null;
    btn.textContent = '…';
    btn.disabled = true;
    await new Promise((res) => {
      r.onstop = res;
      r.stop();
    });
    r.stream.getTracks().forEach((t) => t.stop());
    try {
      const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
      if (blob.size < 500) throw new Error('nothing was recorded');
      const out = await apiFetch('/api/voice/transcribe', { method: 'POST', body: blob, headers: { 'content-type': blob.type } });
      const text = String(out?.text ?? '').trim();
      if (text) {
        textarea.value = textarea.value ? `${textarea.value.replace(/\s+$/, '')} ${text}` : text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      status('Dictate');
    } catch (e) {
      status(`Could not recognise: ${e.message}`);
    }
    btn.textContent = '🎤';
    btn.disabled = false;
  }

  btn.onclick = async () => {
    if (rec) return void stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MIME.find((m) => MediaRecorder.isTypeSupported(m));
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.start();
      btn.textContent = '⏹';
      status('Recording — press again to stop');
      // a runaway recording is cut at five minutes (the server limit)
      setTimeout(() => void stop(), 5 * 60_000);
    } catch (e) {
      status('The microphone is not allowed yet');
      onNeedPermission?.(e);
    }
  };
  return btn;
}
