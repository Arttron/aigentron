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
