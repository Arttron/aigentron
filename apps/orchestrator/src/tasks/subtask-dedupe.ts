/** Is this new subtask the same piece of work as one that already exists? (Agents must not multiply tasks by re-asking for the same thing.) */

const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Word set of a prompt (first 600 characters is plenty to tell two requests apart). */
function words(s: string): Set<string> {
  return new Set(norm(s).slice(0, 600).split(' ').filter((w) => w.length > 1));
}

/** Same work: identical after normalisation, or near-identical wording (Jaccard similarity ≥ 0.85 of the words). */
export function isSameWork(a: string, b: string): boolean {
  const na = norm(a).slice(0, 400);
  const nb = norm(b).slice(0, 400);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = words(a);
  const wb = words(b);
  if (wa.size < 4 || wb.size < 4) return false; // too short to judge
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter) >= 0.85;
}

/** Subtask statuses a repeat request is answered with instead of a new subtask (a failed / blocked / cancelled one may be retried). */
export const REUSABLE_STATUSES = ['queued', 'running', 'needs_approval', 'review', 'done'] as const;

/** Subtasks that are over (finished, cancelled or failed) do not count towards the cap — only the ones still open do. */
export const SUBTASK_OVER: readonly string[] = ['done', 'cancelled', 'failed'];
/** A hard ceiling on ALL subtasks ever created under one task (a multiple of the open cap), so an agent cannot loop create → finish forever. */
export const TOTAL_SUBTASK_FACTOR = 4;

/** Why an agent may not create another subtask under a task (null = it may). */
export function subtaskCapError(statuses: readonly string[], limit: number): string | null {
  const open = statuses.filter((s) => !SUBTASK_OVER.includes(s)).length;
  if (open >= limit) {
    return `This task already has ${open} open subtasks (limit ${limit}). Reuse or finish the existing ones (check_subtasks / complete_subtask) instead of splitting further.`;
  }
  if (statuses.length >= limit * TOTAL_SUBTASK_FACTOR) {
    return `This task has had ${statuses.length} subtasks in total (ceiling ${limit * TOTAL_SUBTASK_FACTOR}). Ask the person to continue the work in a new task.`;
  }
  return null;
}
