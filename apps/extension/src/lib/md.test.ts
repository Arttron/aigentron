import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module (the extension has no build step for its own sources)
import { blocks, inline } from './md.js';

describe('side panel markdown blocks', () => {
  it('a quote is a block of its own, the reply after it is a paragraph', () => {
    expect(blocks('> first\n> second\n\nagreed, but why?')).toEqual([
      { type: 'quote', text: 'first\nsecond' },
      { type: 'p', text: 'agreed, but why?' },
    ]);
  });
  it('a quote does not swallow a list or code that follows it', () => {
    expect(blocks('> q\n- a\n- b\n```\ncode\n```').map((b: { type: string }) => b.type)).toEqual(['quote', 'list', 'code']);
  });
  it('plain paragraphs, lists and code are as before', () => {
    expect(blocks('one\ntwo\n\n- a').map((b: { type: string }) => b.type)).toEqual(['p', 'list']);
  });
});

describe('side panel inline markdown', () => {
  // inline() builds DOM nodes: a minimal stand-in is enough to read what it makes
  const node = (tag: string, props: Record<string, unknown> = {}) => ({ tag, ...props });
  (globalThis as unknown as { document: unknown }).document = { createTextNode: (text: string) => node('#text', { textContent: text }), createElement: (tag: string) => node(tag) };
  const kinds = (src: string) => inline(src).map((n: { tag: string }) => n.tag);

  it('bold, italic, strike, code and a safe link', () => {
    expect(kinds('a **b** *c* ~~d~~ `e` [f](https://x.io)')).toEqual(['#text', 'strong', '#text', 'em', '#text', 'del', '#text', 'code', '#text', 'a']);
  });
  it('a mark must hug its text: globs, products and snake_case stay as typed', () => {
    expect(kinds('open *.ts files, 5 * 3 = 15 and snake_case_name')).toEqual(['#text']);
  });
  it('only http(s) links become links', () => expect(kinds('[x](javascript:alert(1)) and [y](data:text/html,hi)')).toEqual(['#text']));
  it('a long line of unfinished links cannot make the panel slow (linear time)', () => {
    for (const line of ['[a](http://'.repeat(20_000), '['.repeat(60_000), '*'.repeat(60_000), '~'.repeat(60_000)]) {
      const t = Date.now();
      inline(line);
      expect(Date.now() - t).toBeLessThan(400);
    }
  });
});

