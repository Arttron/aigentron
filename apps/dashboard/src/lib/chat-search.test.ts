import { describe, expect, it } from 'vitest';
import { markPieces, rangeFrom, speakerLabel, taskAtMessage } from './chat-search';

describe('markPieces', () => {
  it('cuts the text around the marks', () => {
    expect(markPieces('В Литве и Литвы', [[2, 7], [10, 15]])).toEqual([
      { text: 'В ', mark: false },
      { text: 'Литве', mark: true },
      { text: ' и ', mark: false },
      { text: 'Литвы', mark: true },
    ]);
  });
  it('no marks = the text whole; bad or overlapping ranges are ignored', () => {
    expect(markPieces('abc', [])).toEqual([{ text: 'abc', mark: false }]);
    expect(markPieces('abc', [[1, 2], [1, 3], [5, 9], [2, 2]]).map((p) => p.text).join('')).toBe('abc');
  });
});

describe('rangeFrom', () => {
  it('is the local date N days back; none for any time', () => {
    expect(rangeFrom('any')).toBeUndefined();
    expect(rangeFrom('7', new Date(2026, 10, 10, 12))).toBe('2026-11-03');
    expect(rangeFrom('365', new Date(2026, 10, 10, 12))).toBe('2025-11-10');
  });
});

describe('labels and links', () => {
  it('names who said it', () => {
    expect(speakerLabel({ kind: 'prompt', speaker: null })).toBe('you');
    expect(speakerLabel({ kind: 'discussion', speaker: 'Analyst' })).toBe('Analyst');
    expect(speakerLabel({ kind: 'result', speaker: null })).toBe('result');
  });
  it('the deep link carries the message id', () => {
    expect(taskAtMessage('t1', 's1:4')).toBe('/tasks/t1?ev=s1%3A4');
  });
});
