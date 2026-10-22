import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref } from './markdown-parse';

describe('safeHref', () => {
  it('allows http(s) and mailto only', () => {
    expect(safeHref('https://a.dev/x')).toBe('https://a.dev/x');
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<b>')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
  });
});

describe('parseInline', () => {
  it('handles code, bold, italic and keeps raw HTML as text', () => {
    const t = parseInline('a `x` **b** *c* <script>alert(1)</script>');
    expect(t.map((x) => x.t)).toEqual(['text', 'code', 'text', 'bold', 'text', 'italic', 'text']);
    expect(JSON.stringify(t)).toContain('<script>'); // as a text token — React escapes it
  });
  it('refuses javascript: links (stays text) and trims trailing punctuation from bare URLs', () => {
    expect(parseInline('[x](javascript:alert(1))').every((x) => x.t !== 'link')).toBe(true);
    const t = parseInline('see https://a.dev/x.');
    expect(t.find((x) => x.t === 'link')).toMatchObject({ href: 'https://a.dev/x' });
    expect(t[t.length - 1]).toEqual({ t: 'text', v: '.' });
  });
  it('does not treat snake_case or a lone star as emphasis', () => {
    expect(parseInline('my_var_name * 2').every((x) => x.t === 'text')).toBe(true);
  });
});

describe('parseMarkdown', () => {
  it('parses fences, headings, lists and quotes', () => {
    const b = parseMarkdown('# T\n\ntext\nmore\n\n- a\n- b\n\n1. x\n2. y\n\n> q\n\n```ts\nconst a = 1;\n```');
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'ul', 'ol', 'quote', 'code']);
    expect(b[5]).toMatchObject({ lang: 'ts', v: 'const a = 1;' });
  });
  it('an unclosed fence (streaming) keeps the rest as code', () => {
    expect(parseMarkdown('```\nabc\ndef')[0]).toMatchObject({ t: 'code', v: 'abc\ndef' });
  });
  it('empty input gives no blocks', () => expect(parseMarkdown('')).toEqual([]));
});

import { isNumericColumn, parseSeparator, splitRow } from './markdown-parse';

describe('tables', () => {
  const TABLE = ['| Провайдер | Запусков | Стоимость |', '|---|---|---|', '| claude-code | 212 | **$269.72** |', '| DS | 65 | $44.40 |'].join('\n');

  it('parses a pipe table with a separator line into head, alignment and rows', () => {
    const [b] = parseMarkdown(TABLE);
    expect(b).toMatchObject({ t: 'table' });
    if (b?.t !== 'table') throw new Error('not a table');
    expect(b.head).toHaveLength(3);
    expect(b.rows).toHaveLength(2);
    // numeric columns are right-aligned on their own, the text column is not
    expect(b.align).toEqual([null, 'right', 'right']);
  });

  it('honours explicit alignment markers and a table between paragraphs', () => {
    const md = ['Расход:', '', '| a | b | c |', '|:--|:-:|--:|', '| 1 | 2 | 3 |', '', 'Итого.'].join('\n');
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.t)).toEqual(['p', 'table', 'p']);
    const t = blocks[1]!;
    if (t.t !== 'table') throw new Error('not a table');
    expect(t.align).toEqual(['left', 'center', 'right']);
  });

  it('is not fooled by a line with pipes and no separator, and survives a half-streamed table', () => {
    expect(parseMarkdown('a | b | c').map((b) => b.t)).toEqual(['p']);
    expect(parseMarkdown('| a | b |\n|---|---|').map((b) => b.t)).toEqual(['table']); // header + separator only, rows still coming
    expect(parseMarkdown('| a | b |').map((b) => b.t)).toEqual(['p']);
  });

  it('helpers: cells, separators, numeric columns', () => {
    expect(splitRow('| a | b \\| c | d |')).toEqual(['a', 'b | c', 'd']);
    expect(parseSeparator('|---|:-:|--:|')).toEqual([null, 'center', 'right']);
    expect(parseSeparator('| a | b |')).toBeNull();
    expect(isNumericColumn(['1 327 580', '655 327', '$269.72', '46%'])).toBe(true);
    expect(isNumericColumn(['claude-code', '12'])).toBe(false);
    expect(isNumericColumn(['', '—'])).toBe(false);
  });

  it('cells are still parsed as inline markdown (no raw html)', () => {
    const [b] = parseMarkdown(['| x | y |', '|---|---|', '| **bold** | <b>no</b> |'].join('\n'));
    if (b?.t !== 'table') throw new Error('not a table');
    expect(b.rows[0]![0]![0]).toMatchObject({ t: 'bold' });
    expect(b.rows[0]![1]![0]).toMatchObject({ t: 'text', v: '<b>no</b>' });
  });
});

import { mediaName, parseFileRef } from './markdown-parse';

describe('files of the task referenced from a message', () => {
  it('mediaName takes a bare name, attachment: and a path, never another site', () => {
    expect(mediaName('shot-3-0.png')).toBe('shot-3-0.png');
    expect(mediaName('attachment:plan.JPG')).toBe('plan.JPG');
    expect(mediaName('/data/attachments/abc/before%20after.webp')).toBe('before after.webp');
    expect(mediaName('https://evil.example/x.png')).toBeNull();
    expect(mediaName('notes.pdf')).toBeNull();
    expect(mediaName('..')).toBeNull();
  });
  it('![caption](file) and [text](file) become inline media; an outside image stays a plain link or text', () => {
    expect(parseInline('see ![the plan](plan.png) now')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'media', name: 'plan.png', alt: 'the plan' },
      { t: 'text', v: ' now' },
    ]);
    expect(parseInline('[clip](attachment:a.mp4)')).toEqual([{ t: 'media', name: 'a.mp4', alt: 'clip' }]);
    expect(parseInline('[docs](https://example.com/a)')).toEqual([{ t: 'link', href: 'https://example.com/a', v: 'docs' }]);
    expect(parseInline('![x](https://example.com/p.png)')).toEqual([{ t: 'link', href: 'https://example.com/p.png', v: 'x' }]);
  });
});

describe('colour values become chips', () => {
  it('in running text, with a readable text colour', () => {
    expect(parseInline('main #ffff00 here')).toEqual([
      { t: 'text', v: 'main ' },
      { t: 'color', v: '#ffff00', bg: 'rgb(255, 255, 0)', fg: '#000000' },
      { t: 'text', v: ' here' },
    ]);
    expect(parseInline('rgb(0, 0, 128)')).toEqual([{ t: 'color', v: 'rgb(0, 0, 128)', bg: 'rgb(0, 0, 128)', fg: '#ffffff' }]);
  });
  it('an inline code that is only a colour, even #123; other code stays code', () => {
    expect(parseInline('`#123`')).toEqual([{ t: 'color', v: '#123', bg: 'rgb(17, 34, 51)', fg: '#ffffff' }]);
    expect(parseInline('`const a = #ff0000`')).toEqual([{ t: 'code', v: 'const a = #ff0000' }]);
  });
  it('issue numbers, links and bold keep working', () => {
    expect(parseInline('see #123')).toEqual([{ t: 'text', v: 'see #123' }]);
    expect(parseInline('**#00ff00**')[0]).toMatchObject({ t: 'bold' });
    expect(parseInline('[x](https://a.b/#ff8800)')).toEqual([{ t: 'link', href: 'https://a.b/#ff8800', v: 'x' }]);
  });
});

describe('files of other tasks, by reference', () => {
  it('parseFileRef: own media, attachment:, and task:<id>/<name> for any file type', () => {
    expect(parseFileRef('plan.png')).toEqual({ name: 'plan.png', media: true });
    expect(parseFileRef('attachment:report.pdf')).toEqual({ name: 'report.pdf', media: false });
    expect(parseFileRef('task:cm1/shot-3-0.png')).toEqual({ taskId: 'cm1', name: 'shot-3-0.png', media: true });
    expect(parseFileRef('task:cm1/spec.md')).toEqual({ taskId: 'cm1', name: 'spec.md', media: false });
    for (const v of ['report.pdf', 'https://x.io/a.png', 'task:cm1/../x.png', 'task:cm1/.links.json', 'task:/a.png', '/etc/passwd']) expect(parseFileRef(v), v).toBeNull();
  });
  it('a picture of a subtask is inline media from that task; another file is a file link', () => {
    expect(parseInline('![the design](task:cm1/design.png)')).toEqual([{ t: 'media', name: 'design.png', alt: 'the design', taskId: 'cm1' }]);
    expect(parseInline('[the spec](task:cm1/spec.md)')).toEqual([{ t: 'file', name: 'spec.md', label: 'the spec', taskId: 'cm1' }]);
    expect(parseInline('[](attachment:a.zip)')).toEqual([{ t: 'file', name: 'a.zip', label: 'a.zip' }]);
  });
});
