import { Link } from 'react-router-dom';
import { statusSummary } from '@/lib/collapsed';
import { listStatus } from '@/lib/bulk-actions';
import { cn } from '@/lib/cn';
import type { TaskListItem } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import { ProjectBadge } from '@/components/ProjectBadge';
import { Badge, Button, Muted } from '@/components/ui';
import styles from './TaskList.module.css';

/** "5 subtasks · 3 done · 1 stalled" from the counts the server sends with each task. */
const subtaskLine = (s: NonNullable<TaskListItem['subtasks']>): string =>
  `${s.total} subtask${s.total === 1 ? '' : 's'} · ${statusSummary(Object.entries(s.byStatus).flatMap(([status, n]) => Array<string>(n).fill(status)))}`;

/**
 * The tasks themselves, one row each — a task that was split shows how many subtasks it has and in which states (its page lists them).
 * In selection mode a row is picked instead of opened.
 */
export function TaskList({
  tasks = [],
  onDelete,
  selecting = false,
  selected,
  onToggle,
}: {
  tasks?: TaskListItem[];
  onDelete: (id: string) => void;
  selecting?: boolean;
  selected?: ReadonlySet<string>;
  /** `range` = Shift was held: select / unselect everything between the last row clicked and this one */
  onToggle?: (id: string, range: boolean) => void;
}) {
  if (tasks.length === 0) {
    return <Muted>No tasks yet. Create one above.</Muted>;
  }

  return (
    <ul className={styles.list}>
      {tasks.map((t) => {
        const on = selected?.has(t.id) ?? false;
        const sub = t.subtasks && t.subtasks.total > 0 ? t.subtasks : null;
        return (
          <li key={t.id} className={styles.group}>
            <div
              className={cn(styles.item, selecting && styles.selectable, on && styles.picked)}
              onClick={selecting ? (e) => onToggle?.(t.id, e.shiftKey) : undefined}
              role={selecting ? 'checkbox' : undefined}
              aria-checked={selecting ? on : undefined}
              tabIndex={selecting ? 0 : undefined}
              onKeyDown={selecting ? (e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), onToggle?.(t.id, e.shiftKey)) : undefined}
            >
              {selecting && <input type="checkbox" className={styles.check} checked={on} onChange={() => undefined} onClick={(e) => { e.stopPropagation(); onToggle?.(t.id, e.shiftKey); }} aria-label={`Select ${t.title}`} />}
              <StatusBadge status={listStatus(t) as TaskListItem['status']} />
              {selecting ? (
                <span className={styles.title} dir="auto">
                  {t.title}
                </span>
              ) : (
                <Link className={styles.title} dir="auto" to={`/tasks/${t.id}`}>
                  {t.title}
                </Link>
              )}
              {sub &&
                (selecting ? (
                  <span className={styles.count}>{subtaskLine(sub)}</span>
                ) : (
                  <Link className={styles.count} to={`/tasks/${t.id}`} title="Open the task to see its subtasks">
                    {subtaskLine(sub)}
                  </Link>
                ))}
              {(t._count?.approvals ?? 0) > 0 && <span className={styles.pill}>{t._count?.approvals} ⚠</span>}
              <ProjectBadge project={t.project} />
              {t.agentName && <Badge tone="neutral">{t.agentName}</Badge>}
              <span className={styles.meta}>{new Date(t.createdAt).toLocaleTimeString()}</span>
              {!selecting && (
                <Button variant="red" size="sm" title="Delete task" onClick={() => onDelete(t.id)}>
                  ✕
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
