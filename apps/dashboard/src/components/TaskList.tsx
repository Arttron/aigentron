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
 * Every row starts with a checkbox in a column of its own (always there, so ticking never moves anything); the page's toolbar acts on the ticked ones.
 */
export function TaskList({
  tasks = [],
  onDelete,
  selected,
  onToggle,
}: {
  tasks?: TaskListItem[];
  onDelete: (id: string) => void;
  selected?: ReadonlySet<string>;
  /** `range` = Shift was held: select / unselect everything between the last row ticked and this one */
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
            <div className={cn(styles.item, on && styles.picked)}>
              <input
                type="checkbox"
                className={styles.check}
                checked={on}
                onChange={() => undefined}
                onClick={(e) => onToggle?.(t.id, e.shiftKey)}
                aria-label={`Select ${t.title}`}
                title="Select (Shift-click selects a range)"
              />
              <StatusBadge status={listStatus(t) as TaskListItem['status']} />
              <Link className={styles.title} dir="auto" to={`/tasks/${t.id}`}>
                {t.title}
              </Link>
              {sub && (
                <Link className={styles.count} to={`/tasks/${t.id}`} title="Open the task to see its subtasks">
                  {subtaskLine(sub)}
                </Link>
              )}
              {(t._count?.approvals ?? 0) > 0 && <span className={styles.pill}>{t._count?.approvals} ⚠</span>}
              <ProjectBadge project={t.project} />
              {t.agentName && <Badge tone="neutral">{t.agentName}</Badge>}
              <span className={styles.meta}>{new Date(t.createdAt).toLocaleTimeString()}</span>
              <Button variant="red" size="sm" title="Delete task" onClick={() => onDelete(t.id)}>
                ✕
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
