/**
 * An agent is told who its colleagues are when a run STARTS. A colleague added while the task was waiting (or between two of its runs) is therefore unknown
 * to a lead that resumes the conversation — and its earlier replies may even say "that agent is not visible". On a continued run the lead is told, in one line,
 * who joined since its last run. Nothing is said when nothing changed (no tokens spent), and nothing on the first run (the roster is in its prompt).
 */
export interface Colleague {
  name: string;
  /** how to reach it, as the roster says (`Task tool …` / `create_subtask … only`) */
  how: string;
}

export function newColleaguesNote(previous: readonly string[] | undefined, current: readonly Colleague[]): string {
  if (!previous) return '';
  const known = new Set(previous);
  const added = current.filter((c) => !known.has(c.name));
  if (!added.length) return '';
  return `New colleagues since your last run: ${added.map((c) => `${c.name} (${c.how})`).join('; ')}. Your earlier messages may say they are missing — they are available now.`;
}
