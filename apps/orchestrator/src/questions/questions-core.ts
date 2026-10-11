/** Agent questions — pure helpers (unit-tested). */

export const MAX_OPTIONS = 8;
export const MAX_OPTION_LENGTH = 60;
export const MAX_QUESTION_LENGTH = 800;

/** What the model passed → tidy question + answer choices (trimmed, de-duplicated, bounded). null = nothing to ask. */
export function cleanQuestion(input: { question?: unknown; options?: unknown }): { question: string; options: string[] } | null {
  const question = String(input.question ?? '').trim().slice(0, MAX_QUESTION_LENGTH);
  if (!question) return null;
  const seen = new Set<string>();
  const options: string[] = [];
  for (const raw of Array.isArray(input.options) ? input.options : []) {
    const o = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_OPTION_LENGTH);
    const key = o.toLowerCase();
    if (!o || seen.has(key)) continue;
    seen.add(key);
    options.push(o);
    if (options.length >= MAX_OPTIONS) break;
  }
  return { question, options };
}

/**
 * A person's reply → the answer. A number (or "1", "1.", "№2") picks that option; the text of an option picks it too;
 * anything else is a typed answer (only when allowed).
 */
export function resolveAnswer(
  options: readonly string[],
  allowText: boolean,
  input: { index?: unknown; indexes?: unknown; text?: unknown },
  multiple = false,
): { answer: string; index: number | null } | { error: string } {
  if (multiple) {
    // ticked options (buttons / checkboxes)
    if (Array.isArray(input.indexes)) {
      const picked = [...new Set(input.indexes.filter((n): n is number => Number.isInteger(n)))].sort((a, b) => a - b);
      if (!picked.length) return { error: 'Tick at least one option.' };
      if (picked.some((n) => options[n] === undefined)) return { error: 'There is no such answer option.' };
      return { answer: picked.map((n) => options[n]!).join('; '), index: null };
    }
    // typed: "1, 3" / "1 3" / "1 and 3" / option names separated by commas
    const text = String(input.text ?? '').trim();
    if (!text) return { error: 'Pick answers or type them.' };
    const nums = text.split(/[\s,;.]+/).filter((t) => t && !/^(and|и)$/i.test(t));
    if (nums.length && nums.every((t) => /^\d{1,2}$/.test(t)) && nums.every((t) => options[Number(t) - 1] !== undefined)) {
      return resolveAnswer(options, allowText, { indexes: nums.map((t) => Number(t) - 1) }, true);
    }
    const names = text.split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    const byName = names.map((n) => options.findIndex((o) => o.toLowerCase() === n));
    if (names.length && byName.every((i) => i >= 0)) return resolveAnswer(options, allowText, { indexes: byName }, true);
    if (!allowText && options.length) return { error: `Choose from the options by number: ${options.map((o, i) => `${i + 1}) ${o}`).join(', ')} (e.g. "1, 3").` };
    return { answer: text.slice(0, 4000), index: null };
  }
  const idx = input.index;
  if (typeof idx === 'number' && Number.isInteger(idx)) {
    const o = options[idx];
    return o === undefined ? { error: 'There is no such answer option.' } : { answer: o, index: idx };
  }
  const text = String(input.text ?? '').trim();
  if (!text) return { error: 'Pick an answer or type one.' };
  const num = /^[№#]?\s*(\d{1,2})\s*[.)]?$/.exec(text);
  if (num && options[Number(num[1]) - 1] !== undefined) return { answer: options[Number(num[1]) - 1]!, index: Number(num[1]) - 1 };
  const same = options.findIndex((o) => o.toLowerCase() === text.toLowerCase());
  if (same >= 0) return { answer: options[same]!, index: same };
  if (!allowText && options.length) return { error: `Choose one of the options: ${options.map((o, i) => `${i + 1}) ${o}`).join(', ')}.` };
  return { answer: text.slice(0, 4000), index: null };
}

/** The text the agent gets back. */
export function answerForModel(q: { status: string; answer: string | null; answerIndex: number | null; answeredBy?: string | null }, waitedMinutes: number): string {
  if (q.status === 'answered' && q.answer !== null) {
    return `The user answered${q.answerIndex !== null ? ` (option ${q.answerIndex + 1})` : ''}: ${q.answer}`;
  }
  if (q.status === 'cancelled') return 'The question was cancelled (the task was stopped or the question withdrawn). Continue without it, or report the task as blocked.';
  return `Nobody answered within ${waitedMinutes} min. Choose the safest default yourself and say which one you chose, or report the task as blocked.`;
}
