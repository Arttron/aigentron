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
