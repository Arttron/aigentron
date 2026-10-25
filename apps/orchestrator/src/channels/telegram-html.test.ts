import { describe, expect, it } from 'vitest';
import { toTelegramHtml as h } from './telegram-html';

describe('toTelegramHtml', () => {
  it('file names and paths go in <code>, so Telegram does not link progress.md as a website', () => {
    expect(h('english/plan.md and progress.md')).toBe('<code>english/plan.md</code> and <code>progress.md</code>');
    expect(h('See src/app/page.tsx, then run build.sh.')).toBe('See <code>src/app/page.tsx</code>, then run <code>build.sh</code>.');
    expect(h('Open ./notes/todo.txt now')).toBe('Open <code>./notes/todo.txt</code> now');
    expect(h('The REPORT.PDF is ready')).toBe('The <code>REPORT.PDF</code> is ready');
  });
  it('leaves web addresses and e-mails alone', () => {
    expect(h('docs at https://example.com/readme.md ok')).toBe('docs at https://example.com/readme.md ok');
    expect(h('write to bob@site.md please')).toBe('write to bob@site.md please');
    expect(h('visit example.com today')).toBe('visit example.com today');
    expect(h('version 1.2.3 and 3.14')).toBe('version 1.2.3 and 3.14');
  });
  it('inline and fenced code are kept literally, escaped, and not formatted inside', () => {
    expect(h('run `npm test -- **x**` now')).toBe('run <code>npm test -- **x**</code> now');
    expect(h('```ts\nconst a = <b>1</b> && 2;\n```')).toBe('<pre>const a = &lt;b&gt;1&lt;/b&gt; &amp;&amp; 2;</pre>');
  });
  it('Markdown: bold, italic, headings, bullets, links', () => {
    expect(h('**done** and *maybe* and __bold__ and _it_')).toBe('<b>done</b> and <i>maybe</i> and <b>bold</b> and <i>it</i>');
    expect(h('## Plan\n- one\n* two')).toBe('<b>Plan</b>\n• one\n• two');
    expect(h('[the docs](https://x.io/a?b=1&c=2)')).toBe('<a href="https://x.io/a?b=1&amp;c=2">the docs</a>');
  });
  it('snake_case, math and stray markers stay as typed', () => {
    expect(h('use my_var_name and 2 * 3 * 4')).toBe('use my_var_name and 2 * 3 * 4');
    expect(h('a ** b')).toBe('a ** b');
  });
  it('markup characters in ordinary text are escaped', () => {
    expect(h('if a < b && c > d')).toBe('if a &lt; b &amp;&amp; c &gt; d');
  });
  it('a file name inside bold works', () => {
    expect(h('**Updated plan.md**')).toBe('<b>Updated <code>plan.md</code></b>');
  });
});
