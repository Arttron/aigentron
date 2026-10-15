import { describe, expect, it } from 'vitest';
import { mergeLines } from './merge-lines';

const L = (id: string, text = id) => ({ id, text });

describe('mergeLines', () => {
  it('history first, then live lines that history does not have', () => {
    expect(mergeLines([L('a:1'), L('a:2')], [L('a:3')]).map((l) => l.id)).toEqual(['a:1', 'a:2', 'a:3']);
  });
  it('never drops live lines that arrived while the history was loading', () => {
    const merged = mergeLines([L('a:1')], [L('a:5'), L('a:6')]);
    expect(merged.map((l) => l.id)).toEqual(['a:1', 'a:5', 'a:6']);
  });
  it('dedupes by id: a line present in both is kept once, history version wins', () => {
    const merged = mergeLines([L('a:1', 'old'), L('a:2')], [L('a:2', 'live'), L('a:3', 'live')]);
    expect(merged).toEqual([L('a:1', 'old'), L('a:2'), L('a:3', 'live')]);
  });
  it('dedupes repeats inside either list', () => {
    expect(mergeLines([L('a:1'), L('a:1')], [L('a:2'), L('a:2')]).map((l) => l.id)).toEqual(['a:1', 'a:2']);
  });
  it('handles empty sides and does not mutate inputs', () => {
    const h = [L('a:1')];
    const v = [L('a:2')];
    expect(mergeLines([], [])).toEqual([]);
    expect(mergeLines(h, [])).toEqual(h);
    expect(mergeLines([], v)).toEqual(v);
    mergeLines(h, v);
    expect(h).toHaveLength(1);
    expect(v).toHaveLength(1);
  });
});
