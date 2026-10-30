/**
 * Word-by-word reveal of a new message. Pace: a steady ~30 words/s (about the speed of a streamed model answer — quick enough not to hold the reader
 * back, slow enough to read the start while the rest arrives), and a long message speeds up so that none takes longer than MAX_SECONDS.
 */
export const MIN_WORDS_PER_SECOND = 30;
export const MAX_SECONDS = 3;
/** Shorter messages just appear (the rise animation is enough). */
export const MIN_CHARS = 40;

/** End offset of every whitespace-delimited word. */
export function wordEnds(text: string): number[] {
  const ends: number[] = [];
  for (const m of text.matchAll(/\S+/g)) ends.push((m.index ?? 0) + m[0].length);
  return ends;
}

export const revealRate = (words: number): number => Math.max(MIN_WORDS_PER_SECOND, words / MAX_SECONDS);

/** How many words are visible `elapsedMs` after the start (the first word shows at once). */
export function wordsShown(total: number, elapsedMs: number): number {
  if (total <= 0) return 0;
  return Math.min(total, Math.floor((elapsedMs / 1000) * revealRate(total)) + 1);
}
