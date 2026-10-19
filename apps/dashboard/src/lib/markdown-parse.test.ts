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
