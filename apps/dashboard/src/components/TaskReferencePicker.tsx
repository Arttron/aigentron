import { useEffect, useState } from 'react';
import { api, type TaskListItem } from '@/lib/api';
import styles from './TaskReferencePicker.module.css';

/**
 * Searchable multi-select for referencing other tasks. Referenced tasks'
 * summaries are folded into the new task's / message's context on the server.
 * Reused by the create form, the follow-up composer, and the subtask form.
 *
 * Search hits the server (paginated list endpoint) so it scales past the point
 * where loading every task up front is reasonable.
 */
export function TaskReferencePicker({
  value,
  onChange,
  excludeId,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  excludeId?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<TaskListItem[]>([]);
  // id → title, accumulated from search results so already-picked chips can
  // show a title rather than a bare id.
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api
        .listTasks({ q: q.trim() || undefined, pageSize: 20 })
        .then((r) => {
          setResults(r.items);
          setTitles((m) => {
            const next = { ...m };
            for (const task of r.items) next[task.id] = task.title;
            return next;
          });
        })
        .catch(() => undefined);
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  const titleOf = (id: string) => titles[id] ?? id;
  const available = results.filter((t) => t.id !== excludeId && !value.includes(t.id));

  const add = (id: string) => {
    if (!value.includes(id)) onChange([...value, id]);
    setQ('');
  };

  return (
    <div className={styles.wrap}>
      {value.length > 0 && (
        <div className={styles.chips}>
          {value.map((id) => (
            <span key={id} className={styles.chip} title={id}>
              <span className={styles.chipIcon}>🔗</span>
              <span className={styles.chipLabel}>{titleOf(id)}</span>
              <button
                type="button"
                className={styles.remove}
                aria-label="Remove reference"
                onClick={() => onChange(value.filter((x) => x !== id))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={styles.box}>
        <input
          type="search"
          className={styles.input}
          placeholder="🔗 Reference a task…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && available.length > 0 && (
          <ul className={styles.menu}>
            {available.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className={styles.option}
                  // Fire before the input's blur so the pick isn't lost.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(t.id)}
                >
                  <span className={styles.optionTitle}>{t.title}</span>
                  <span className={styles.optionStatus}>{t.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
