import { describe, expect, it } from 'vitest';
import { findOffsets } from './find-in-text';

describe('findOffsets', () => {
  it('finds every occurrence, ignoring case', () => {
    expect(findOffsets('Бонус и бонусы, БОНУС', 'бонус')).toEqual([[0, 5], [8, 13], [16, 21]]);
  });
  it('treats the query as plain text, not a pattern', () => {
    expect(findOffsets('a.c abc a.c', 'a.c')).toEqual([[0, 3], [8, 11]]);
    expect(findOffsets('(x)', '(x)')).toEqual([[0, 3]]);
  });
  it('spaces in the query match any run of white space', () => {
    expect(findOffsets('налоговый\n  бонус', 'налоговый бонус')).toEqual([[0, 17]]);
  });
  it('an empty query finds nothing', () => {
    expect(findOffsets('abc', '  ')).toEqual([]);
  });
});
