import { describe, expect, it } from 'vitest';
import { docKind, parseDelimited } from './doc-kinds';

describe('docKind', () => {
  it('knows what can be previewed', () => {
    expect(docKind('Plan.MD')).toBe('md');
    expect(docKind('report.html')).toBe('html');
    expect(docKind('a/b/data.tsv')).toBe('csv');
    expect(docKind('x.json')).toBe('json');
    expect(docKind('notes.txt')).toBe('text');
    expect(docKind('x.pdf')).toBe('pdf');
    expect(docKind('photo.png')).toBeNull();
    expect(docKind('noext')).toBeNull();
  });
});

describe('parseDelimited', () => {
  it('quotes, doubled quotes, embedded newlines', () => {
    expect(parseDelimited('a,b\n"x,1","he said ""hi"""\n"l1\nl2",z', ',')).toEqual([['a', 'b'], ['x,1', 'he said "hi"'], ['l1\nl2', 'z']]);
    expect(parseDelimited('a\tb\r\nc\td\r\n', '\t')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});
