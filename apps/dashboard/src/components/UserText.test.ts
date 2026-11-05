import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UserText } from './UserText';

const html = (text: string): string => renderToStaticMarkup(createElement(UserText, { text }));

describe('UserText: what a person typed, in the conversation', () => {
  it('a message with no formatting looks exactly as before (a plain span)', () => {
    expect(html('just words, snake_case and *.ts files')).toBe('<span dir="auto">just words, snake_case and *.ts files</span>');
  });
  it('formatting made in the composer is shown formatted', () => {
    const h = html('do **this**, *that*, ~~not~~ `x` and [docs](https://example.com)');
    expect(h).toContain('<strong>this</strong>');
    expect(h).toContain('<em>that</em>');
    expect(h).toContain('<del>not</del>');
    expect(h).toContain('>x</code>');
    expect(h).toContain('href="https://example.com/"');
  });
  it('lists and quotes', () => {
    const h = html('- one\n- two\n\n1. a\n2. b\n\n> said');
    expect(h).toContain('<ul>');
    expect(h).toContain('<ol>');
    expect(h).toContain('<blockquote>');
  });
  it('a fenced block next to formatted text', () => {
    const h = html('**first**\n```ts\nconst x = 1;\n```\nthen plain');
    expect(h).toContain('<strong>first</strong>');
    expect(h).toContain('const x = 1;');
    expect(h).toContain('then plain');
  });
  it('never turns markup typed by a person into elements (no raw html)', () => {
    const h = html('**bold** <script>alert(1)</script> <b>x</b>');
    expect(h).not.toContain('<script>');
    expect(h).not.toContain('<b>');
    expect(h).toContain('&lt;script&gt;');
  });
  it('a quote with a reply under it: the quote is a block, the reply is plain', () => {
    const h = html('> first line of the quote\n> second line\n\nagreed, but why?');
    expect(h).toContain('<blockquote>');
    expect(h).toContain('first line of the quote');
    expect(h).toContain('second line');
    expect(h).toContain('agreed, but why?');
    expect(h.indexOf('</blockquote>')).toBeLessThan(h.indexOf('agreed, but why?'));
  });
});
