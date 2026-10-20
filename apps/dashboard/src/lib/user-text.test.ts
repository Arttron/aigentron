import { describe, expect, it } from 'vitest';
import { hasFence, splitFences } from './user-text';

describe('splitFences', () => {
  it('plain text is one text segment, untouched', () => {
    expect(splitFences('just *words* and _more_')).toEqual([{ t: 'text', v: 'just *words* and _more_' }]);
    expect(hasFence('just words')).toBe(false);
  });
  it('splits text, a fenced block and text', () => {
    expect(splitFences('look:\n```bash\n$ ls\nfoo\n```\nwhat is that?')).toEqual([
      { t: 'text', v: 'look:' },
      { t: 'code', lang: 'bash', v: '$ ls\nfoo' },
      { t: 'text', v: 'what is that?' },
    ]);
  });
  it('a longer fence can contain a shorter one', () => {
    expect(splitFences('````text\nhas ``` inside\n````')).toEqual([{ t: 'code', lang: 'text', v: 'has ``` inside' }]);
  });
  it('an unclosed fence runs to the end, and several blocks work', () => {
    expect(splitFences('```js\nconst a = 1;')).toEqual([{ t: 'code', lang: 'js', v: 'const a = 1;' }]);
    expect(splitFences('```a\n1\n```\n```b\n2\n```').map((s) => (s.t === 'code' ? s.lang : s.t))).toEqual(['a', 'b']);
    expect(hasFence('x\n```\ny\n```')).toBe(true);
  });
  it('keeps blank lines inside the block and trims the ones around text', () => {
    expect(splitFences('\n\nbefore\n\n```\na\n\nb\n```\n\n')).toEqual([
      { t: 'text', v: 'before' },
      { t: 'code', lang: '', v: 'a\n\nb' },
    ]);
  });
});
