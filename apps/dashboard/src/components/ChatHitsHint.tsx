import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ChatSearchResult } from '@/lib/api';
import { markPieces, speakerLabel, taskAtMessage } from '@/lib/chat-search';
import styles from './ChatHitsHint.module.css';

/** Under the task list's search box: the same words found INSIDE conversations (the list itself matches titles and first requests only). */
export function ChatHitsHint({ q, project }: { q: string; project?: string }) {
  const [res, setRes] = useState<ChatSearchResult | null>(null);
  const text = q.trim();
  useEffect(() => {
    if (!text) {
      setRes(null);
      return;
    }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.searchChats({ q: text, project: project || undefined, pageSize: 3 }, ctl.signal).then((r) => !ctl.signal.aborted && setRes(r)).catch(() => undefined);
    }, 400);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [text, project]);

  if (!text || !res || res.total === 0) return null;
  return (
    <div className={styles.box} role="region" aria-label="Found in conversations">
      <div className={styles.head}>
        <span>
          Also in conversations: {res.messages} {res.messages === 1 ? 'message' : 'messages'} in {res.total} {res.total === 1 ? 'task' : 'tasks'}
        </span>
        <Link to={`/search?q=${encodeURIComponent(text)}${project ? `&project=${encodeURIComponent(project)}` : ''}`}>All results →</Link>
      </div>
      {res.tasks.map((t) => {
        const h = t.hits[0]!;
        return (
          <Link key={t.taskId} className={styles.row} to={taskAtMessage(t.taskId, h.line)}>
            <span className={styles.title}>{t.title}</span>
            <span className={styles.snip}>
              <b>{speakerLabel(h)}</b>{' '}
              {markPieces(h.snippet.text, h.snippet.marks).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
