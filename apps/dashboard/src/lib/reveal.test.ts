import { describe, expect, it } from 'vitest';
import { revealRate, wordEnds, wordsShown } from './reveal';

describe('reveal', () => {
  it('word ends', () => {
    expect(wordEnds('ab  cd\nef')).toEqual([2, 6, 9]);
    expect(wordEnds('   ')).toEqual([]);
  });
  it('steady pace for short text, bounded time for long', () => {
    expect(revealRate(60)).toBe(30);
    expect(revealRate(900)).toBe(300);
    expect(wordsShown(60, 0)).toBe(1);
    expect(wordsShown(60, 1000)).toBe(31);
    expect(wordsShown(60, 5000)).toBe(60);
    expect(wordsShown(900, 3000)).toBe(900); // the whole text in MAX_SECONDS
    expect(wordsShown(0, 100)).toBe(0);
  });
});
