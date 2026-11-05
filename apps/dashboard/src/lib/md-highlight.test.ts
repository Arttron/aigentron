import { describe, expect, it } from 'vitest';
import { highlightLines } from './md-highlight';

const lineText = (l: { segs: { text: string }[] }) => l.segs.map((s) => s.text).join('');
const classesOf = (src: string, text: string) => highlightLines(src).flatMap((l) => l.segs).filter((s) => s.text === text).map((s) => s.cls);

describe('highlightLines', () => {
  it('never changes a character: every line comes back exactly', () => {
    const src = 'plain\n**bold** and *it* ~~old~~ `x` [a](https://e.com) https://e.com/z.\n- item **b**\n1. one\n> q\n```ts\nconst a = 1;\n```\ntail  \n\n';
    const lines = highlightLines(src);
    expect(lines.map(lineText)).toEqual(src.split('\n'));
  });
  it('dims the marks and styles what they mark', () => {
    expect(classesOf('say **hi**', 'hi')).toEqual([['bold']]);
    expect(classesOf('say **hi**', '**')).toEqual([['mark'], ['mark']]);
    expect(classesOf('a ~~x~~', 'x')).toEqual([['strike']]);
    expect(classesOf('a `x`', 'x')).toEqual([['code']]);
    expect(classesOf('[docs](https://e.com)', 'docs')).toEqual([['link']]);
    expect(classesOf('[docs](https://e.com)', 'https://e.com')).toEqual([['url']]);
  });
  it('code nests inside bold', () => expect(classesOf('**a `b` c**', 'b')).toEqual([['bold', 'code']]));
  it('list and quote markers', () => {
    expect(classesOf('- one', '-')).toEqual([['bullet']]);
    expect(classesOf('12. one', '12.')).toEqual([['bullet']]);
    expect(classesOf('> said', '>')).toEqual([['quote']]);
  });
  it('a fenced block: fences are marks, lines inside are code (an unclosed block runs to the end)', () => {
    const l = highlightLines('```ts\nlet x = 1;\n**not bold**\n```\nafter **bold**');
    expect(l.map((x) => x.kind)).toEqual(['fence', 'code', 'code', 'fence', 'plain']);
    expect(highlightLines('```\nopen').map((x) => x.kind)).toEqual(['fence', 'code']);
  });
  it('a glob or a product is not italic (the same hugging rule as the chat)', () => {
    expect(highlightLines('open *.ts files, 5 * 3 = 15')[0]!.segs.every((s) => !s.cls.includes('italic'))).toBe(true);
    expect(highlightLines('snake_case_name')[0]!.segs).toEqual([{ text: 'snake_case_name', cls: [] }]);
  });
  it('a pasted address is an url, without its trailing full stop', () => {
    expect(classesOf('see https://e.com/a.', 'https://e.com/a')).toEqual([['url']]);
  });
});

describe('review fixes', () => {
  it('a link text with unbalanced brackets cannot make highlighting slow (linear time)', () => {
    for (const line of ['['.repeat(50_000), '[a'.repeat(25_000), ('[x] ' + '['.repeat(100)).repeat(300)]) {
      const t = Date.now();
      highlightLines(line);
      expect(Date.now() - t).toBeLessThan(400);
    }
  });
  it('an address the chat would not link is plain text in the live view too', () => {
    expect(highlightLines('[x](javascript:alert(1))')[0]!.segs.some((s) => s.cls.includes('link'))).toBe(false);
    expect(highlightLines('[x](https://e.com)')[0]!.segs.some((s) => s.cls.includes('link'))).toBe(true);
  });
  it('same fence rule as the chat: a longer opening fence is not closed by a shorter line', () => {
    expect(highlightLines('````\ncode\n```\nstill code\n````').map((l) => l.kind)).toEqual(['fence', 'code', 'code', 'code', 'fence']);
  });
});
