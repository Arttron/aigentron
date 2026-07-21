import Link from 'next/link';
import { cn } from '@/lib/cn';
import type { TaskListItem } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import { Badge, Button, Muted } from '@/components/ui';
import styles from './TaskList.module.css';

export function TaskList({
  tasks = [],
  onDelete,
}: {
  tasks?: TaskListItem[];
  onDelete: (id: string) => void;
}) {
  if (tasks.length === 0) {
    return <Muted>No tasks yet. Create one above.</Muted>;
  }

  // Group subtasks under their parent. Children are indented beneath the parent
  // row (in creation order); a subtask whose parent isn't in the list falls back
  // to a top-level row so nothing is hidden.
  const ids = new Set(tasks.map((t) => t.id));
  const childrenOf = new Map<string, TaskListItem[]>();
  for (const t of tasks) {
    if (t.parentId && ids.has(t.parentId)) {
      (childrenOf.get(t.parentId) ?? childrenOf.set(t.parentId, []).get(t.parentId)!).push(t);
    }
  }
  for (const kids of childrenOf.values()) {
    kids.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const topLevel = tasks.filter((t) => !(t.parentId && ids.has(t.parentId)));

  const row = (t: TaskListItem, isChild: boolean) => {
    const kids = childrenOf.get(t.id) ?? [];
    return (
      <li key={t.id} className={styles.group}>
        <div className={cn(styles.item, isChild && styles.child)}>
          {isChild && <span className={styles.branch} aria-hidden />}
          <StatusBadge status={t.status} />
          <Link className={styles.title} href={`/tasks/${t.id}`}>
            {t.title}
          </Link>
          {!isChild && kids.length > 0 && (
            <span className={styles.count} title="subtasks">
              ⋔ {kids.length}
            </span>
          )}
          {(t._count?.approvals ?? 0) > 0 && <span className={styles.pill}>{t._count?.approvals} ⚠</span>}
          {t.agentName && <Badge tone="neutral">{t.agentName}</Badge>}
          <span className={styles.meta}>{new Date(t.createdAt).toLocaleTimeString()}</span>
          <Button variant="red" size="sm" title="Delete task" onClick={() => onDelete(t.id)}>
            ✕
          </Button>
        </div>
        {kids.length > 0 && <ul className={styles.children}>{kids.map((k) => row(k, true))}</ul>}
      </li>
    );
  };

  return <ul className={styles.list}>{topLevel.map((t) => row(t, false))}</ul>;
}
