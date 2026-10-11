import type { TaskStatus } from '@lds/shared';

/** Status filter of the task list: one status, or a group. */
export const STATUS_FILTERS = ['queued', 'running', 'needs_approval', 'review', 'done', 'blocked', 'failed', 'stalled', 'cancelled', 'active', 'attention'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const isStatusFilter = (v: unknown): v is StatusFilter => typeof v === 'string' && (STATUS_FILTERS as readonly string[]).includes(v);

/**
 * Statuses a filter stands for. `active` = still being worked on; `attention` = needs a person: asking for approval, blocked on a question,
 * stalled without a report, or failed.
 */
export function statusesOf(f: StatusFilter): TaskStatus[] {
  if (f === 'active') return ['queued', 'running', 'needs_approval'];
  if (f === 'attention') return ['needs_approval', 'blocked', 'stalled', 'failed'];
  return [f];
}
