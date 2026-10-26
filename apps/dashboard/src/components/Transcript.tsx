import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TaskStatus } from '@lds/shared';
import { isVideo } from '@/lib/capture';
import { MediaViewer } from './MediaViewer';
import { DocViewer } from './DocViewer';
import { docKind } from '@/lib/doc-kinds';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useLook, useShow } from '@/lib/transcript-look';
import { Muted } from '@/components/ui';
import { Markdown, MediaTaskContext } from './Markdown';
import { UserText } from './UserText';
import { SpeakButton } from './SpeakButton';
import { CopyButton } from './CopyButton';
import { Collapsible } from './Collapsible';
import { speakText, useAutoSpeak, useVoice, useVoiceOnly } from '@/lib/voice';
import { buildItems, type Item, type LogLine } from '@/lib/transcript-items';
import styles from './Transcript.module.css';

export type { LogLine, Item };
export { buildItems };

const formatTs = (ts?: string) => {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/** No event from the agent for this long while running → show a "no reply" notice. */
const SILENCE_MS = 30_000;

/** Ambient strip under the chat: a light runs along it while a request is in flight; each event from the agent flashes it at a random spot. */
const PIXEL_COLORS = ['#ff4d4d', '#ffa500', '#ffee33', '#4dff7c', '#33ffee', '#4d79ff', '#d94dff', '#ff66c4'];
function AmbientStrip({ running, activityAt, look }: { running: boolean; activityAt?: number; look: string }) {
  const [flashes, setFlashes] = useState<{ id: number; x: number; w: number; color: string }[]>([]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!running) return;
    const id = Date.now() + Math.random();
    const color =
      look === 'terminal'
        ? PIXEL_COLORS[Math.floor(Math.random() * PIXEL_COLORS.length)]
        : `hsl(${Math.floor(Math.random() * 360)} 90% 62%)`;
    setFlashes((f) => [...f.slice(-5), { id, x: 4 + Math.random() * 92, w: look === 'terminal' ? 8 * (2 + Math.floor(Math.random() * 5)) : 40 + Math.random() * 70, color }]);
    const t = setTimeout(() => setFlashes((f) => f.filter((x) => x.id !== id)), 1100);
    return () => clearTimeout(t);
  }, [activityAt, running]);
  return (
    <div className={cn(styles.strip, running && styles.stripOn)} data-look={look} aria-hidden>
      {running && <span className={styles.runner} />}
      {flashes.map((f) => (
        <span key={f.id} className={styles.flash} style={{ left: `${f.x}%`, width: f.w, ['--c' as string]: f.color }} />
      ))}
    </div>
  );
}

/** The "no reply" notice owns the 5 s ticker, so the whole transcript does not re-render with it. */
const SilenceNotice = memo(function SilenceNotice({ running, activityAt }: { running: boolean; activityAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [running]);
  const silentSec = running && activityAt ? Math.floor((now - activityAt) / 1000) : 0;
  if (!running || silentSec * 1000 < SILENCE_MS) return null;
  return (
    <div className={cn(styles.line, styles.working)}>
      ⏳ No reply from the agent for {silentSec} s — it may still be thinking (the first reply of a slow or local model can take minutes). If this
      keeps going, check the provider or stop the task.
    </div>
  );
});

const WORKING: Partial<Record<TaskStatus, string>> = {
  queued: 'queued — waiting for a free worker slot',
  running: 'agent is working',
  needs_approval: 'waiting for your approval above',
};

/** A steady colour per speaker so a conversation between several agents is easy to follow. */
export function speakerColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 58%)`;
}

const firstLine = (s: string, max = 110) => {
  const one = (s.split('\n')[0] ?? '').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

export function Transcript({
  taskId,
  lines,
  status,
  terminal,
  fill = false,
  onAsk,
  activityAt,
  localModel = false,
}: {
  taskId: string;
  /** Timestamp (ms) of the last event from the agent. */
  activityAt?: number;
  /** The agent runs a local model through the LiteLLM gateway — the first reply can take minutes. */
  localModel?: boolean;
  /** Lets a photo / video be opened for a conversation (mark a spot, ask). */
  onAsk?: (prompt: string, attachments: string[]) => Promise<void>;
  lines: LogLine[];
  status: TaskStatus;
  terminal: boolean;
  /** Fill the height of the parent (phone layout) instead of a fixed maximum. */
  fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<{ name: string; names?: string[] } | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [translated, setTranslated] = useState<Record<string, string>>({});
  const translate = (id: string, text: string) => {
    setTranslated((m) => ({ ...m, [id]: '…' }));
    void api
      .translate(text, navigator.language || 'English')
      .then((r) => setTranslated((m) => ({ ...m, [id]: r.ok && r.text ? r.text : `⚠ ${r.error ?? 'could not translate'}` })))
      .catch((e) => setTranslated((m) => ({ ...m, [id]: `⚠ ${(e as Error).message}` })));
  };
  // Messages that arrive after the chat has been on screen for a moment rise out of the strip.
  const known = useRef<Set<string>>(new Set());
  const rising = useRef<Set<string>>(new Set());
  const liveFrom = useRef<number | null>(null);
  if (lines.length > 0 && liveFrom.current === null) liveFrom.current = Date.now() + 1500;
  const isLive = liveFrom.current !== null && Date.now() > liveFrom.current;
  const rise = (id: string) => {
    if (!known.current.has(id)) {
      known.current.add(id);
      if (isLive) rising.current.add(id);
    }
    return rising.current.has(id) ? styles.rise : undefined;
  };
  const [look, setLook] = useLook();
  const [show, setShow] = useShow();
  // Follow new output unless the user has scrolled up. Captured from the user's
  // last scroll (not from post-append metrics) so a big incoming chunk doesn't
  // trip the "near bottom" check and stop auto-scrolling mid-stream.
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  // Read new answers aloud when the person turned that on (voice-only mode speaks by itself, so skip it here).
  const voice = useVoice();
  const [autoSpeak] = useAutoSpeak();
  const [voiceOnly] = useVoiceOnly();
  const spoken = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let last: LogLine | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.kind === 'result') {
        last = lines[i];
        break;
      }
    }
    if (spoken.current === undefined) {
      spoken.current = last?.id ?? null; // what was already there when the page opened is not "new"
      return;
    }
    if (!last || last.id === spoken.current) return;
    spoken.current = last.id;
    if (autoSpeak && !voiceOnly && voice?.ttsReady && last.text.trim())
      void speakText(last.text).catch(() => undefined);
  }, [lines, autoSpeak, voiceOnly, voice]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAway(!near);
  };

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, status, show, look]);

  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAway(false);
  };

  const all = useMemo(() => buildItems(lines), [lines]);
  // one read-aloud button only: on the latest answer
  const lastFinalId = useMemo(() => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.kind === 'result') return lines[i]!.id;
    return undefined;
  }, [lines]);

  if (lines.length === 0 && terminal) {
    return <Muted>No output.</Muted>;
  }

  const isPic = (n: string) => /\.(jpe?g|png|webp|gif)$/i.test(n);
  /** An agent's pictures: one large, several as an album grid (click → the viewer, with ‹ › through the album). */
  const album = (names: string[]): ReactNode => {
    const pics = names.filter(isPic);
    const rest = names.filter((n) => !isPic(n));
    return (
      <>
        {pics.length > 0 && (
          <div className={cn(styles.album, pics.length === 1 && styles.albumOne, pics.length === 2 && styles.albumTwo)} data-count={Math.min(pics.length, 9)}>
            {pics.slice(0, 9).map((name, i) => (
              <button key={`${name}-${i}`} type="button" className={styles.albumCell} title={name} onClick={() => setViewing({ name, names: pics })}>
                <img src={api.attachmentUrl(taskId, name)} alt={name} loading="lazy" />
                {i === 8 && pics.length > 9 && <span className={styles.albumMore}>+{pics.length - 9}</span>}
              </button>
            ))}
          </div>
        )}
        {rest.length > 0 && thumbs(rest)}
      </>
    );
  };

  const thumbs = (attachments?: string[], asAlbum = false): ReactNode =>
    asAlbum && attachments && attachments.some(isPic) ? (
      album(attachments)
    ) : attachments && attachments.length > 0 ? (
      <span className={styles.thumbs}>
        {attachments.map((name) => (
          <a
            key={name}
            href={api.attachmentUrl(taskId, name)}
            target="_blank"
            rel="noreferrer"
            title={name}
            onClick={(e) => {
              if (docKind(name)) {
                e.preventDefault();
                setDoc(name);
                return;
              }
              // photos and videos open in the viewer (mark a spot and ask); other files open as before
              if (!onAsk || !(isVideo(name) || /\.(jpe?g|png|webp|gif)$/i.test(name))) return;
              e.preventDefault();
              setViewing({ name });
            }}
          >
            {docKind(name) ? (
              <span className={styles.docChip}>📄 {name.replace(/^task:[\w-]+\//, '')}</span>
            ) : isVideo(name) ? (
              <video src={api.attachmentUrl(taskId, name)} className={styles.thumb} preload="metadata" muted />
            ) : (
              <img src={api.attachmentUrl(taskId, name)} alt={name} className={styles.thumb} />
            )}
          </a>
        ))}
      </span>
    ) : null;

  const ts = (l: LogLine) =>
    formatTs(l.ts) ? <span className={styles.ts}>{formatTs(l.ts)}</span> : null;

  const items =
    show === 'messages'
      ? all.filter((it) => it.type !== 'tool' && !(it.type === 'note' && it.line.kind === 'system'))
      : all;
  const hidden = all.length - items.length;

  return (
    <div className={cn(styles.wrap, fill && styles.fill)} data-look={look}>
      <div className={styles.bar}>
        <span className={styles.seg} role="group" aria-label="Conversation style">
          {(['terminal', 'classic'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={look === v}
              className={cn(styles.segBtn, look === v && styles.segOn)}
              onClick={() => setLook(v)}
            >
              {v}
            </button>
          ))}
        </span>
        <span className={styles.seg} role="group" aria-label="What to show">
          {(['all', 'messages'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={show === v}
              className={cn(styles.segBtn, show === v && styles.segOn)}
              onClick={() => setShow(v)}
            >
              {v === 'all' ? 'all steps' : 'messages only'}
            </button>
          ))}
        </span>
        {hidden > 0 && <span className={styles.hiddenNote}>{hidden} step(s) hidden</span>}
      </div>

      <div
        className={styles.transcript}
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-relevant="additions"
        data-look={look}
      >
        {items.map((it, n) => {
          if (it.type === 'user') {
            return (
              <div key={it.line.id} className={cn(styles.userMsg, rise(it.line.id))}>
                <span className={styles.prompt} aria-label="you">
                  you&gt;
                </span>
                {ts(it.line)}
                {it.line.text && <UserText text={it.line.text} className={styles.userText} />}
                {it.line.id.startsWith('pending-') && <span style={{ opacity: 0.6, fontSize: 11, marginLeft: 6 }}>sending…</span>}
                {thumbs(it.line.attachments)}
                {it.line.text && <CopyButton text={it.line.text} label="Copy your message" />}
              </div>
            );
          }
          if (it.type === 'agent') {
            return (
              <div key={it.line.id} className={cn(styles.agentMsg, it.final && styles.final, rise(it.line.id))}>
                <span className={styles.prompt} aria-label={it.line.speaker ?? 'agent'} style={it.line.speaker ? { color: speakerColor(it.line.speaker) } : undefined}>
                  {it.line.speaker ? `${it.line.speaker}>` : it.final ? 'result>' : 'agent>'}
                </span>
                {ts(it.line)}
                <div className={styles.agentBody}>
                  {it.line.speaker && it.line.speaker !== 'system' ? (
                    // a subtask's report or a discussion turn: long ones fold to ten lines
                    <Collapsible resetKey={it.line.id}>
                      <MediaTaskContext.Provider value={taskId}>
                        <Markdown text={it.line.text} />
                      </MediaTaskContext.Provider>
                    </Collapsible>
                  ) : (
                    <MediaTaskContext.Provider value={taskId}>
                      <Markdown text={it.line.text} />
                    </MediaTaskContext.Provider>
                  )}
                  {it.line.speaker && it.line.speaker !== 'system' && (
                    <div>
                      {translated[it.line.id] === undefined ? (
                        <button type="button" className={styles.translateBtn} onClick={() => translate(it.line.id, it.line.text)} title="Translate into your language (a few tokens)">
                          🌐 translate
                        </button>
                      ) : (
                        <div className={styles.translated} dir="auto">
                          {translated[it.line.id]}
                        </div>
                      )}
                    </div>
                  )}
                  {it.final && autoSpeak && it.line.id === lastFinalId && (
                    <SpeakButton text={it.line.text} abs />
                  )}
                  {thumbs(it.line.attachments, true)}
                  <div>
                    <CopyButton text={it.line.text} />
                  </div>
                </div>
              </div>
            );
          }
          if (it.type === 'tool') {
            const title = firstLine(it.use?.text ?? it.result?.text ?? '');
            const body = [it.use?.text, it.result?.text].filter(Boolean).join('\n\n— result —\n');
            const key = it.use?.id ?? it.result?.id ?? String(n);
            return (
              <details key={key} className={styles.tool}>
                <summary>
                  <span className={styles.toolMark} aria-hidden>
                    ▸
                  </span>
                  <span className={styles.toolTitle}>{title || 'tool call'}</span>
                  {it.result ? (
                    <span className={styles.toolDone}>[done]</span>
                  ) : (
                    <span className={styles.toolRun}>[running]</span>
                  )}
                </summary>
                <pre className={styles.toolBody}>{body}</pre>
                {thumbs(it.result?.attachments)}
              </details>
            );
          }
          const l = it.line;
          return (
            <div key={l.id} className={cn(styles.line, styles[l.kind], rise(l.id))}>
              <span className={styles.kind}>{l.kind}</span>
              {ts(l)}
              {l.text}
              {thumbs(l.attachments)}
            </div>
          );
        })}
        {status === 'review' && (
          <div className={cn(styles.line, styles.working)}>
            ✅ The agent has finished. Happy with the result? Write “done” (or press Mark as done) to close the task — or write what to change.
          </div>
        )}
        <SilenceNotice running={status === 'running'} activityAt={activityAt} />
        {WORKING[status] && (
          <div className={cn(styles.line, styles.working)}>
            {WORKING[status]}
            {status === 'running' && localModel && ' (a local model can take a few minutes for the first reply)'}
            <span className={styles.cursor} aria-hidden>
              █
            </span>
          </div>
        )}
      </div>
      <AmbientStrip running={status === 'running'} activityAt={activityAt} look={look} />
      {away && (
        <button type="button" className={styles.jump} onClick={toBottom}>
          ↓ latest
        </button>
      )}
      {doc && <DocViewer taskId={taskId} name={doc} onClose={() => setDoc(null)} />}
      {viewing && <MediaViewer taskId={taskId} name={viewing.name} names={viewing.names} onClose={() => setViewing(null)} onAsk={onAsk} />}
    </div>
  );
}
