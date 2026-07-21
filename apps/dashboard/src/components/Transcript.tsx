'use client';

import { useEffect, useRef } from 'react';
import type { TaskStatus } from '@lds/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Muted } from '@/components/ui';
import styles from './Transcript.module.css';

export interface LogLine {
  id: string;
  kind: string;
  text: string;
  attachments?: string[];
}

const WORKING: Partial<Record<TaskStatus, string>> = {
  queued: '▷ queued — waiting for a free worker slot…',
  running: '● agent is working… (local models can take a few minutes for the first reply)',
  needs_approval: '⏸ waiting for your approval above…',
};

export function Transcript({
  taskId,
  lines,
  status,
  terminal,
}: {
  taskId: string;
  lines: LogLine[];
  status: TaskStatus;
  terminal: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Follow new output unless the user has scrolled up. Captured from the user's
  // last scroll (not from post-append metrics) so a big incoming chunk doesn't
  // trip the "near bottom" check and stop auto-scrolling mid-stream.
  const stick = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, status]);

  if (lines.length === 0 && terminal) {
    return <Muted>No output.</Muted>;
  }

  const thumbs = (attachments?: string[]) =>
    attachments && attachments.length > 0 ? (
      <span className={styles.thumbs}>
        {attachments.map((name) => (
          <a
            key={name}
            href={api.attachmentUrl(taskId, name)}
            target="_blank"
            rel="noreferrer"
            title={name}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={api.attachmentUrl(taskId, name)} alt={name} className={styles.thumb} />
          </a>
        ))}
      </span>
    ) : null;

  return (
    <div className={styles.transcript} ref={ref} onScroll={onScroll}>
      {lines.map((l) =>
        l.kind === 'prompt' ? (
          <div key={l.id} className={styles.userMsg}>
            <span className={styles.userTag}>you</span>
            {l.text && <span className={styles.userText}>{l.text}</span>}
            {thumbs(l.attachments)}
          </div>
        ) : (
          <div key={l.id} className={cn(styles.line, styles[l.kind])}>
            <span className={styles.kind}>{l.kind}</span>
            {l.text}
            {thumbs(l.attachments)}
          </div>
        ),
      )}
      {WORKING[status] && <div className={cn(styles.line, styles.working)}>{WORKING[status]}</div>}
    </div>
  );
}
