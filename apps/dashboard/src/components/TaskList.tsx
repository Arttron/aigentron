import { useState } from 'react';
import { Link } from 'react-router-dom';
import { readCollapsed, statusSummary, writeCollapsed } from '@/lib/collapsed';
import { cn } from '@/lib/cn';
import type { TaskListItem } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import { ProjectBadge } from '@/components/ProjectBadge';
import { Badge, Button, Muted } from '@/components/ui';
import styles from './TaskList.module.css';

export function TaskList({
  tasks = [],
  onDelete,
}: {
  tasks?: TaskListItem[];
  onDelete: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsed(next);
      return next;
    });

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
          <Link className={styles.title} dir="auto" to={`/tasks/${t.id}`}>
            {t.title}
          </Link>
          {!isChild && kids.length > 0 && (
            <button
              type="button"
              className={styles.count}
              aria-expanded={!collapsed.has(t.id)}
              title={collapsed.has(t.id) ? `Show ${kids.length} subtask(s) — ${statusSummary(kids.map((k) => k.status))}` : 'Hide the subtasks'}
              onClick={() => toggle(t.id)}
            >
              {collapsed.has(t.id) ? '▸' : '▾'} {kids.length} subtask{kids.length === 1 ? '' : 's'}
            </button>
          )}
          {(t._count?.approvals ?? 0) > 0 && <span className={styles.pill}>{t._count?.approvals} ⚠</span>}
          <ProjectBadge project={t.project} />
          {t.agentName && <Badge tone="neutral">{t.agentName}</Badge>}
          <span className={styles.meta}>{new Date(t.createdAt).toLocaleTimeString()}</span>
          <Button variant="red" size="sm" title="Delete task" onClick={() => onDelete(t.id)}>
            ✕
          </Button>
        </div>
        {kids.length > 0 && collapsed.has(t.id) && <div className={styles.summary}>{statusSummary(kids.map((k) => k.status))}</div>}
        {kids.length > 0 && !collapsed.has(t.id) && <ul className={styles.children}>{kids.map((k) => row(k, true))}</ul>}
      </li>
    );
  };

  return <ul className={styles.list}>{topLevel.map((t) => row(t, false))}</ul>;
}
