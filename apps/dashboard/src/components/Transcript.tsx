import { useEffect, useRef, useState } from 'react';
import type { TaskStatus } from '@lds/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useLook, useShow } from '@/lib/transcript-look';
import { Muted } from '@/components/ui';
import { Markdown } from './Markdown';
import styles from './Transcript.module.css';

export interface LogLine {
  id: string;
  kind: string;
  text: string;
  attachments?: string[];
  ts?: string;
}

const formatTs = (ts?: string) => {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const WORKING: Partial<Record<TaskStatus, string>> = {
  queued: 'queued — waiting for a free worker slot',
  running: 'agent is working (a local model can take a few minutes for the first reply)',
  needs_approval: 'waiting for your approval above',
};

type Item =
  | { type: 'user'; line: LogLine }
  | { type: 'agent'; line: LogLine; final: boolean }
  | { type: 'tool'; use: LogLine | null; result: LogLine | null }
  | { type: 'note'; line: LogLine };

/** Folds the flat event list into chat items: a tool call and its result become ONE collapsible row. */
export function buildItems(lines: LogLine[]): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.kind === 'prompt') items.push({ type: 'user', line: l });
    else if (l.kind === 'assistant') items.push({ type: 'agent', line: l, final: false });
    else if (l.kind === 'result') items.push({ type: 'agent', line: l, final: true });
    else if (l.kind === 'tool_use') {
      const next = lines[i + 1];
      if (next?.kind === 'tool_result') {
        items.push({ type: 'tool', use: l, result: next });
        i++;
      } else items.push({ type: 'tool', use: l, result: null });
    } else if (l.kind === 'tool_result') items.push({ type: 'tool', use: null, result: l });
    else items.push({ type: 'note', line: l });
  }
  return items;
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
}: {
  taskId: string;
  lines: LogLine[];
  status: TaskStatus;
  terminal: boolean;
  /** Fill the height of the parent (phone layout) instead of a fixed maximum. */
  fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [look, setLook] = useLook();
  const [show, setShow] = useShow();
  // Follow new output unless the user has scrolled up. Captured from the user's
  // last scroll (not from post-append metrics) so a big incoming chunk doesn't
  // trip the "near bottom" check and stop auto-scrolling mid-stream.
  const stick = useRef(true);
  const [away, setAway] = useState(false);

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

  if (lines.length === 0 && terminal) {
    return <Muted>No output.</Muted>;
  }

  const thumbs = (attachments?: string[]) =>
    attachments && attachments.length > 0 ? (
      <span className={styles.thumbs}>
        {attachments.map((name) => (
          <a key={name} href={api.attachmentUrl(taskId, name)} target="_blank" rel="noreferrer" title={name}>
            <img src={api.attachmentUrl(taskId, name)} alt={name} className={styles.thumb} />
          </a>
        ))}
      </span>
    ) : null;

  const ts = (l: LogLine) => (formatTs(l.ts) ? <span className={styles.ts}>{formatTs(l.ts)}</span> : null);

  const all = buildItems(lines);
  const items = show === 'messages' ? all.filter((it) => it.type !== 'tool' && !(it.type === 'note' && it.line.kind === 'system')) : all;
  const hidden = all.length - items.length;

  return (
    <div className={cn(styles.wrap, fill && styles.fill)} data-look={look}>
      <div className={styles.bar}>
        <span className={styles.seg} role="group" aria-label="Conversation style">
          {(['terminal', 'classic'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={look === v} className={cn(styles.segBtn, look === v && styles.segOn)} onClick={() => setLook(v)}>
              {v}
            </button>
          ))}
        </span>
        <span className={styles.seg} role="group" aria-label="What to show">
          {(['all', 'messages'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={show === v} className={cn(styles.segBtn, show === v && styles.segOn)} onClick={() => setShow(v)}>
              {v === 'all' ? 'all steps' : 'messages only'}
            </button>
          ))}
        </span>
        {hidden > 0 && <span className={styles.hiddenNote}>{hidden} step(s) hidden</span>}
      </div>

      <div className={styles.transcript} ref={ref} onScroll={onScroll} role="log" aria-live="polite" data-look={look}>
        {items.map((it, n) => {
          if (it.type === 'user') {
            return (
              <div key={it.line.id} className={styles.userMsg}>
                <span className={styles.prompt} aria-label="you">you&gt;</span>
                {ts(it.line)}
                {it.line.text && <span className={styles.userText}>{it.line.text}</span>}
                {thumbs(it.line.attachments)}
              </div>
            );
          }
          if (it.type === 'agent') {
            return (
              <div key={it.line.id} className={cn(styles.agentMsg, it.final && styles.final)}>
                <span className={styles.prompt} aria-label="agent">{it.final ? 'done>' : 'agent>'}</span>
                {ts(it.line)}
                <div className={styles.agentBody}>
                  <Markdown text={it.line.text} />
                  {thumbs(it.line.attachments)}
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
                  <span className={styles.toolMark} aria-hidden>▸</span>
                  <span className={styles.toolTitle}>{title || 'tool call'}</span>
                  {it.result ? <span className={styles.toolDone}>[done]</span> : <span className={styles.toolRun}>[running]</span>}
                </summary>
                <pre className={styles.toolBody}>{body}</pre>
                {thumbs(it.result?.attachments)}
              </details>
            );
          }
          const l = it.line;
          return (
            <div key={l.id} className={cn(styles.line, styles[l.kind])}>
              <span className={styles.kind}>{l.kind}</span>
              {ts(l)}
              {l.text}
              {thumbs(l.attachments)}
            </div>
          );
        })}
        {WORKING[status] && (
          <div className={cn(styles.line, styles.working)}>
            {WORKING[status]}
            <span className={styles.cursor} aria-hidden>█</span>
          </div>
        )}
      </div>
      {away && (
        <button type="button" className={styles.jump} onClick={toBottom}>
          ↓ latest
        </button>
      )}
    </div>
  );
}
