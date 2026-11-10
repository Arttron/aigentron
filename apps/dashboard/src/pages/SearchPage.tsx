import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type AgentInfo, type ChatSearchParams, type ChatSearchResult, type ChatSearchTask } from '@/lib/api';
import type { Project } from '@lds/shared';
import { AppHeader, Badge, Button, ErrorText } from '@/components/ui';
import { DATE_RANGES, markPieces, rangeFrom, speakerLabel, taskAtMessage, type DateRange } from '@/lib/chat-search';
import styles from './SearchPage.module.css';

const SCOPES: { value: NonNullable<ChatSearchParams['scope']>; label: string; hint: string }[] = [
  { value: 'all', label: 'All messages', hint: 'Everything said in the conversations' },
  { value: 'mine', label: 'Mine', hint: 'Messages people wrote, in tasks I created' },
  { value: 'agents', label: 'Agents', hint: 'What agents answered' },
  { value: 'results', label: 'Results only', hint: 'The final answers of runs' },
];
const STATUSES = ['', 'active', 'attention', 'review', 'done', 'blocked', 'failed', 'stalled'];
const PAGE_SIZE = 20;

/** The server's reason out of an API error ("400 Bad Request — {"message":"…"}"). */
function readableError(raw: string): string {
  const body = raw.replace(/^\d+ [^—]*— /, '');
  try {
    const m = (JSON.parse(body) as { message?: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.join('; ');
  } catch {
    /* not JSON: shown as it is */
  }
  return body;
}

const when = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Search in chats (main menu → Search): the words of every conversation, found across all tasks, opened at the message. docs/chat-search.md */
export function SearchPage() {
  const [sp, setSp] = useSearchParams();
  const urlQ = sp.get('q') ?? '';
  const scope = (SCOPES.find((s) => s.value === sp.get('scope'))?.value ?? 'all') as NonNullable<ChatSearchParams['scope']>;
  const project = sp.get('project') ?? '';
  const agent = sp.get('agent') ?? '';
  const status = sp.get('status') ?? '';
  const range = (DATE_RANGES.find((r) => r.value === sp.get('range'))?.value ?? 'any') as DateRange;
  const sort = sp.get('sort') === 'new' ? 'new' : 'best';
  const mode = sp.get('mode') === 'pattern' ? 'pattern' : 'words';

  // the box is typed in freely; the address (and the search) follows a moment later
  const [text, setText] = useState(urlQ);
  useEffect(() => setText(urlQ), [urlQ]);
  const setParam = useCallback(
    (changes: Record<string, string>) => {
      const next = new URLSearchParams(sp);
      for (const [k, v] of Object.entries(changes)) (v ? next.set(k, v) : next.delete(k));
      setSp(next, { replace: true });
    },
    [sp, setSp],
  );
  useEffect(() => {
    if (text.trim() === urlQ.trim()) return;
    const t = window.setTimeout(() => setParam({ q: text.trim() }), 300);
    return () => window.clearTimeout(t);
  }, [text, urlQ, setParam]);

  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  useEffect(() => {
    api.listProjects().then(setProjects).catch(() => undefined);
    api.listAgents().then(setAgents).catch(() => undefined);
  }, []);

  const [tasks, setTasks] = useState<ChatSearchTask[]>([]);
  const [meta, setMeta] = useState<Pick<ChatSearchResult, 'total' | 'messages' | 'indexed' | 'pattern'> | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = rangeFrom(range);
  const key = useMemo(() => JSON.stringify([urlQ.trim(), scope, project, agent, status, from, sort, mode]), [urlQ, scope, project, agent, status, from, sort, mode]);
  const lastKey = useRef('');

  useEffect(() => {
    const q = urlQ.trim();
    if (!q) {
      setTasks([]);
      setMeta(null);
      setError(null);
      lastKey.current = key;
      return;
    }
    // a new question starts from page 1; "show more" asks for the next page of the same one
    const nextPage = lastKey.current === key ? page : 1;
    if (nextPage === 1 && page !== 1) setPage(1);
    lastKey.current = key;
    const ctl = new AbortController();
    setBusy(true);
    api
      .searchChats({ q, scope, project, agent, status, from, sort, mode, page: nextPage, pageSize: PAGE_SIZE }, ctl.signal)
      .then((r) => {
        setError(null);
        setMeta({ total: r.total, messages: r.messages, indexed: r.indexed, pattern: r.pattern });
        setTasks((prev) => (nextPage === 1 ? r.tasks : [...prev, ...r.tasks]));
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        setError(readableError(e.message));
        setTasks([]);
        setMeta(null);
      })
      .finally(() => !ctl.signal.aborted && setBusy(false));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page]);

  // while the old history is still being indexed, look again: results fill in as it goes
  const [indexed, setIndexed] = useState(1);
  useEffect(() => {
    let live = true;
    const look = () => api.chatSearchStatus().then((s) => live && setIndexed(s.indexed)).catch(() => undefined);
    void look();
    const t = window.setInterval(() => void look(), 5000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  const filtered = Boolean(project || agent || status || range !== 'any');
  const q = urlQ.trim();

  return (
    <div className={styles.page}>
      <AppHeader title="🔎 Search in chats" />
      <label className={styles.box}>
        <span aria-hidden>🔎</span>
        <input
          type="search"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={mode === 'pattern' ? 'Pattern (regular expression), e.g. \\d{4}-\\d{2}-\\d{2} or лит\\w+' : 'Words from a conversation — "exact phrase", -leave out'}
          aria-label="Search in chats"
        />
        {text && (
          <button type="button" className={styles.clear} aria-label="Clear" onClick={() => setText('')}>
            ×
          </button>
        )}
      </label>

      <div className={styles.chips} role="group" aria-label="What to search">
        {SCOPES.map((s) => (
          <button key={s.value} type="button" className={styles.chip} aria-pressed={scope === s.value} title={s.hint} onClick={() => setParam({ scope: s.value === 'all' ? '' : s.value })}>
            {s.label}
          </button>
        ))}
        <button
          type="button"
          className={styles.chip}
          aria-pressed={mode === 'pattern'}
          title="Treat the text as a regular expression: dates, links, numbers, a word's forms. Reads the latest messages (the word index is not used)."
          onClick={() => setParam({ mode: mode === 'pattern' ? '' : 'pattern' })}
        >
          .* Pattern
        </button>
        {projects.length > 0 && (
          <select className={styles.select} aria-label="Project" value={project} onChange={(e) => setParam({ project: e.target.value })}>
            <option value="">Any project</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select className={styles.select} aria-label="Agent" value={agent} onChange={(e) => setParam({ agent: e.target.value })}>
          <option value="">Any agent</option>
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        <select className={styles.select} aria-label="Task status" value={status} onChange={(e) => setParam({ status: e.target.value })}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s ? s.replace('_', ' ') : 'Any status'}
            </option>
          ))}
        </select>
        <select className={styles.select} aria-label="Date" value={range} onChange={(e) => setParam({ range: e.target.value === 'any' ? '' : e.target.value })}>
          {DATE_RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {indexed < 1 && (
        <div className={styles.note} role="status">
          Older messages are still being indexed ({Math.round(indexed * 100)} %). Results may be missing; they appear as it goes — a few minutes, once, after the update.
          <div className={styles.bar} aria-hidden>
            <div style={{ width: `${Math.round(indexed * 100)}%` }} />
          </div>
        </div>
      )}
      {error && <ErrorText>{error}</ErrorText>}

      {!q && mode === 'pattern' && (
        <div className={styles.empty}>
          A <b>regular expression</b>, not case-sensitive; <code>\w</code> and <code>\b</code> know every script.
          <br />
          Examples: <code>\d{'{4}'}-\d{'{2}'}-\d{'{2}'}</code> (a date) · <code>https?://\S+</code> (a link) · <code>лит\w+</code> (any form of a word) · <code>(error|failed)\b</code>
        </div>
      )}
      {!q && mode !== 'pattern' && (
        <div className={styles.empty}>
          Type a few words you remember — in any language. Several words must all be in the message; <b>"in quotes"</b> is an exact phrase; <b>-word</b> leaves a word out.
          <br />
          Forms of a word meet: «Литве» finds «Литва» and «Литвы».
        </div>
      )}

      {mode === 'pattern' && meta?.pattern && (meta.pattern.timedOut || meta.pattern.truncated) && (
        <div className={styles.note} role="status">
          {meta.pattern.timedOut
            ? 'The pattern was too slow and was stopped — make it simpler (avoid nested repeats like (a+)+).'
            : `Only the latest ${meta.pattern.scanned.toLocaleString()} messages were read. Narrow it with the filters (project, agent, date) to look further back.`}
        </div>
      )}
      {q && meta && (
        <div className={styles.status}>
          <span>
            {meta.messages} {meta.messages === 1 ? 'message' : 'messages'} in {meta.total} {meta.total === 1 ? 'task' : 'tasks'}
          </span>
          <span>
            Sort:{' '}
            <button type="button" className={styles.chip} aria-pressed={sort === 'best'} onClick={() => setParam({ sort: '' })}>
              Best match
            </button>{' '}
            <button type="button" className={styles.chip} aria-pressed={sort === 'new'} onClick={() => setParam({ sort: 'new' })}>
              Newest
            </button>
          </span>
        </div>
      )}

      {q && meta && meta.total === 0 && !busy && (
        <div className={styles.empty}>
          <b>Nothing found</b> for «{q}»{filtered ? ' with these filters' : ''}.
          <br />
          {filtered ? 'Loosen a filter, or ' : 'Try fewer or shorter words, or '}check the spelling — forms of a word are matched, typos are not.
          {filtered && (
            <div style={{ marginTop: 10 }}>
              <Button onClick={() => setParam({ project: '', agent: '', status: '', range: '', scope: '' })}>Clear filters</Button>
            </div>
          )}
        </div>
      )}

      <div className={styles.results}>
        {tasks.map((t) => (
          <article key={t.taskId} className={styles.hit}>
            <div className={styles.head}>
              <Link className={styles.title} to={`/tasks/${encodeURIComponent(t.taskId)}`}>
                <span>{t.title}</span>
                <Badge tone={t.status}>{t.status.replace('_', ' ')}</Badge>
              </Link>
              <span className={styles.meta}>
                {[t.project?.name, t.agent, when(t.updatedAt)].filter(Boolean).join(' · ')}
              </span>
            </div>
            {t.hits.map((h) => (
              <Link key={h.eventId} className={styles.snip} to={taskAtMessage(t.taskId, h.line)} title="Open the conversation at this message">
                <span className={styles.who}>{speakerLabel(h)}</span> <span className={styles.when}>{when(h.at)}</span>
                <br />
                {markPieces(h.snippet.text, h.snippet.marks).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
              </Link>
            ))}
          </article>
        ))}
        {meta && tasks.length < meta.total && (
          <div style={{ textAlign: 'center' }}>
            <Button disabled={busy} onClick={() => setPage((p) => p + 1)}>
              {busy ? 'Loading…' : `Show more (${meta.total - tasks.length})`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
