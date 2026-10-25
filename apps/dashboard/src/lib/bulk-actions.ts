/**
 * Bulk actions on the selected tasks of the list. Which task an action makes sense for depends on its status; the rest are skipped (and counted),
 * never failed one by one with an error each.
 */
import { isTerminalStatus, type TaskStatus } from '@lds/shared';

export type BulkAction = 'delete' | 'cancel' | 'done';

const ACCEPTABLE = new Set(['review', 'blocked', 'stalled', 'failed']);

export const BULK_LABEL: Record<BulkAction, string> = { delete: 'Delete', cancel: 'Cancel', done: 'Mark as done' };

export function appliesTo(action: BulkAction, status: string): boolean {
  if (action === 'delete') return true;
  // the same rule as the task page's Cancel button: anything not settled
  if (action === 'cancel') return !isTerminalStatus(status as TaskStatus);
  return ACCEPTABLE.has(status);
}

/** The ids the action will touch, and how many selected tasks it skips. */
export function planBulk(action: BulkAction, tasks: readonly { id: string; status: string }[]): { ids: string[]; skipped: number } {
  const ids = tasks.filter((t) => appliesTo(action, t.status)).map((t) => t.id);
  return { ids, skipped: tasks.length - ids.length };
}

/** Run `fn` over `ids` a few at a time; resolves with how many worked and the first few error messages (one failure never stops the rest). */
export async function runBulk(ids: readonly string[], fn: (id: string) => Promise<unknown>, parallel = 3): Promise<{ ok: number; failed: number; errors: string[] }> {
  let ok = 0;
  let failed = 0;
  const errors: string[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < ids.length; i = next++) {
      try {
        await fn(ids[i]!);
        ok++;
      } catch (e) {
        failed++;
        if (errors.length < 3) errors.push((e as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, ids.length) }, worker));
  return { ok, failed, errors };
}

/**
 * The status the task LIST shows. A lead that is idle (queued for its next turn, finished its turn, stalled) while one of its subtasks is running is
 * working, as far as a person is concerned: the row says `running`. A task that waits for a person (approval, blocked on a question), and every
 * settled one (done, failed, cancelled), keeps its own status.
 */
export function listStatus(t: { status: string; subtasks?: { byStatus: Record<string, number> } }): string {
  const idle = t.status === 'queued' || t.status === 'review' || t.status === 'stalled';
  return idle && (t.subtasks?.byStatus.running ?? 0) > 0 ? 'running' : t.status;
}

/** The ids from `from` to `to` inclusive, in list order (either may come first). An id that is not in the list gives just `to`. */
export function rangeIds(ids: readonly string[], from: string | null, to: string): string[] {
  const b = ids.indexOf(to);
  const a = from === null ? -1 : ids.indexOf(from);
  if (b < 0) return [];
  if (a < 0) return [to];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}
