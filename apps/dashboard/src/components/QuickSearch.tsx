import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Project } from '@lds/shared';
import { api, type ChatSearchTask, type TaskListItem } from '@/lib/api';
import { markPieces, speakerLabel, taskAtMessage } from '@/lib/chat-search';
import styles from './QuickSearch.module.css';

const PROJECT_KEY = 'lds.quicksearch.project';

interface Row {
  key: string;
  to: string;
  title: string;
  /** a message hit: who said it and the marked snippet */
  hit?: { who: string; text: string; marks: [number, number][] };
}

/** The palette's rows: the best message hits first (one per task), then tasks found by title. */
export function paletteRows(messages: ChatSearchTask[], titles: Pick<TaskListItem, 'id' | 'title'>[], limit = 8): Row[] {
  const rows: Row[] = messages.map((t) => {
    const h = t.hits[0]!;
    return { key: `m:${t.taskId}`, to: taskAtMessage(t.taskId, h.line), title: t.title, hit: { who: speakerLabel(h), text: h.snippet.text, marks: h.snippet.marks } };
  });
  const have = new Set(messages.map((t) => t.taskId));
  for (const t of titles) if (!have.has(t.id)) rows.push({ key: `t:${t.id}`, to: `/tasks/${encodeURIComponent(t.id)}`, title: t.title });
  return rows.slice(0, limit);
}

/** Quick search: Ctrl/Cmd+K from anywhere. Enter opens the conversation at the message; Shift+Enter shows every result on the Search page. */
export function QuickSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  // the project to look in ('' = all); remembered between openings
  const [project, setProject] = useState(() => {
    try {
      return window.localStorage.getItem(PROJECT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [projects, setProjects] = useState<Project[]>([]);
  const pickProject = (slug: string) => {
    setProject(slug);
    try {
      if (slug) window.localStorage.setItem(PROJECT_KEY, slug);
      else window.localStorage.removeItem(PROJECT_KEY);
    } catch {
      /* not remembered */
    }
    input.current?.focus();
  };
  const nav = useNavigate();
  const { pathname } = useLocation();
  const input = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQ('');
    setRows([]);
    setAt(0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(close, [pathname, close]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    api.listProjects().then((ps) => {
      setProjects(ps);
      // a project that was deleted since: back to all
      setProject((cur) => (cur && !ps.some((p) => p.slug === cur) ? '' : cur));
    }).catch(() => undefined);
  }, [open]);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setRows([]);
      return;
    }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      setBusy(true);
      Promise.all([
        api.searchChats({ q: text, project: project || undefined, pageSize: 6 }, ctl.signal).then((r) => r.tasks).catch(() => [] as ChatSearchTask[]),
        api.listTasks({ q: text, project: project || undefined, pageSize: 4 }, ctl.signal).then((p) => p.items).catch(() => [] as TaskListItem[]),
      ])
        .then(([messages, titles]) => {
          if (ctl.signal.aborted) return;
          setRows(paletteRows(messages, titles));
          setAt(0);
        })
        .finally(() => !ctl.signal.aborted && setBusy(false));
    }, 200);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [q, project]);

  if (!open) return null;
  const searchUrl = () => `/search?q=${encodeURIComponent(q.trim())}${project ? `&project=${encodeURIComponent(project)}` : ''}`;
  const go = (to: string) => {
    close();
    nav(to);
  };
  return (
    <div className={styles.backdrop} onClick={close} role="presentation">
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Quick search" onClick={(e) => e.stopPropagation()}>
        <label className={styles.box}>
          <span aria-hidden>🔎</span>
          <input
            ref={input}
            value={q}
            placeholder="Search in chats and task titles"
            aria-label="Quick search"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setAt((i) => (rows.length ? (i + 1) % rows.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setAt((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey || !rows[at]) go(searchUrl());
                else go(rows[at]!.to);
              }
            }}
          />
          {q && (
            <button type="button" className={styles.clear} aria-label="Clear the search" title="Clear" onMouseDown={(e) => e.preventDefault()} onClick={() => setQ('')}>
              ×
            </button>
          )}
          <kbd className={styles.kbd}>Esc</kbd>
        </label>
        {projects.length > 0 && (
          <div className={styles.scope}>
            <label>
              <span>Project</span>
              <select aria-label="Project to search in" value={project} onChange={(e) => pickProject(e.target.value)}>
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className={styles.list} role="listbox" aria-label="Results">
          {rows.map((r, i) => (
            <button key={r.key} type="button" role="option" aria-selected={i === at} className={styles.row} onMouseEnter={() => setAt(i)} onClick={() => go(r.to)}>
              <span className={styles.title}>{r.title}</span>
              {r.hit && (
                <span className={styles.snip}>
                  <b>{r.hit.who}</b>{' '}
                  {markPieces(r.hit.text, r.hit.marks).map((p, j) => (p.mark ? <mark key={j}>{p.text}</mark> : <span key={j}>{p.text}</span>))}
                </span>
              )}
            </button>
          ))}
          {q.trim() && !rows.length && !busy && <div className={styles.empty}>Nothing found.</div>}
          {!q.trim() && <div className={styles.empty}>Type a few words — any language. Forms of a word meet.</div>}
        </div>
        <div className={styles.foot}>
          <span>
            <kbd className={styles.kbd}>↑</kbd> <kbd className={styles.kbd}>↓</kbd> move · <kbd className={styles.kbd}>Enter</kbd> open at the message
          </span>
          <span>
            <kbd className={styles.kbd}>Shift</kbd>+<kbd className={styles.kbd}>Enter</kbd> all results
          </span>
        </div>
      </div>
    </div>
  );
}
