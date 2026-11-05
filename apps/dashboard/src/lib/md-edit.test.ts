import { describe, expect, it } from 'vitest';
import { applyFormat, continueList, enterInFence, fenceState, insertQuote, diffRange, insertLink, pasteLinkOverSelection, shortcutAction, toggleCodeBlock, toggleLinePrefix, toggleWrap, type Edit } from './md-edit';

const at = (s: string): Edit => {
  // `|` marks the caret, `[` … `]` the selection
  const a = s.indexOf('[');
  const b = s.indexOf(']');
  if (a >= 0 && b > a) return { text: s.slice(0, a) + s.slice(a + 1, b) + s.slice(b + 1), start: a, end: b - 1 };
  const c = s.indexOf('|');
  return { text: s.replace('|', ''), start: c, end: c };
};
const show = (e: Edit): string => (e.start === e.end ? `${e.text.slice(0, e.start)}|${e.text.slice(e.start)}` : `${e.text.slice(0, e.start)}[${e.text.slice(e.start, e.end)}]${e.text.slice(e.end)}`);

describe('toggleWrap', () => {
  it('wraps the selection and keeps it selected', () => expect(show(toggleWrap(at('say [hello] now'), '**'))).toBe('say **[hello]** now'));
  it('takes the marks off when they are just outside the selection', () => expect(show(toggleWrap(at('say **[hello]** now'), '**'))).toBe('say [hello] now'));
  it('takes the marks off when they are inside the selection', () => expect(show(toggleWrap(at('say [**hello**] now'), '**'))).toBe('say [hello] now'));
  it('with no selection puts the marks in and the caret between them', () => expect(show(toggleWrap(at('say |'), '`'))).toBe('say `|`'));
  it('keeps surrounding spaces out of the marks', () => expect(show(toggleWrap(at('a[ word ]b'), '**'))).toBe('a **[word]** b'));
  it('italic does not confuse itself with bold', () => expect(show(toggleWrap(at('**[x]**'), '*'))).toBe('***[x]***'));
  it('strike', () => expect(show(toggleWrap(at('[old]'), '~~'))).toBe('~~[old]~~'));
});

describe('toggleLinePrefix', () => {
  it('makes the touched lines a bulleted list, and back', () => {
    const on = toggleLinePrefix(at('[one\ntwo]\nthree'), 'ul');
    expect(on.text).toBe('- one\n- two\nthree');
    expect(toggleLinePrefix({ ...on, start: 0, end: 12 }, 'ul').text).toBe('one\ntwo\nthree');
  });
  it('numbers lines', () => expect(toggleLinePrefix(at('[a\nb\nc]'), 'ol').text).toBe('1. a\n2. b\n3. c'));
  it('a quote; another kind of marker is replaced, not stacked', () => {
    expect(toggleLinePrefix(at('|hello'), 'quote').text).toBe('> hello');
    expect(toggleLinePrefix(at('|- hello'), 'ol').text).toBe('1. hello');
  });
  it('an empty line gets the marker (to start typing the list)', () => expect(toggleLinePrefix(at('|'), 'ul').text).toBe('- '));
});

describe('code, link, paste', () => {
  it('a code block around the selection, on its own lines', () => expect(toggleCodeBlock(at('run [npm test] now')).text).toBe('run \n```\nnpm test\n```\n now'));
  it('takes the fences off again', () => {
    const on = toggleCodeBlock(at('[x = 1]'));
    expect(on.text).toBe('```\nx = 1\n```');
    expect(toggleCodeBlock({ text: on.text, start: 0, end: on.text.length }).text).toBe('x = 1');
  });
  it('a link: the word is the text, the placeholder address is selected', () => expect(show(insertLink(at('see [docs] here')))).toBe('see [docs]([url]) here'));
  it('pasting an address over a word makes it the link text; otherwise nothing special', () => {
    expect(pasteLinkOverSelection(at('see [docs]'), 'https://example.com/a')?.text).toBe('see [docs](https://example.com/a)');
    expect(pasteLinkOverSelection(at('see |'), 'https://example.com')).toBeNull();
    expect(pasteLinkOverSelection(at('see [docs]'), 'just words')).toBeNull();
  });
});

describe('continueList (Shift+Enter)', () => {
  it('continues a bullet, a number and a quote', () => {
    expect(continueList(at('- one|'))?.text).toBe('- one\n- ');
    expect(continueList(at('1. one|'))?.text).toBe('1. one\n2. ');
    expect(continueList(at('> hi|'))?.text).toBe('> hi\n> ');
  });
  it('an empty item ends the list', () => expect(continueList(at('- one\n- |'))?.text).toBe('- one\n'));
  it('does nothing outside a list, or with a selection', () => {
    expect(continueList(at('plain|'))).toBeNull();
    expect(continueList(at('- [one]'))).toBeNull();
  });
});

describe('shortcutAction', () => {
  const k = (key: string, o: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...o });
  it('maps the Slack-like combinations', () => {
    expect(shortcutAction(k('b'))).toBe('bold');
    expect(shortcutAction(k('I'))).toBe('italic');
    expect(shortcutAction(k('k'))).toBe('link');
    expect(shortcutAction(k('x', { shiftKey: true }))).toBe('strike');
    expect(shortcutAction(k('c', { shiftKey: true }))).toBe('code');
    expect(shortcutAction(k('&', { shiftKey: true, code: 'Digit7' }))).toBe('ol');
    expect(shortcutAction(k('*', { shiftKey: true, code: 'Digit8' }))).toBe('ul');
    expect(shortcutAction(k('(', { shiftKey: true, code: 'Digit9' }))).toBe('quote');
    expect(shortcutAction(k('c', { shiftKey: true, altKey: true }))).toBe('codeblock');
  });
  it('needs ⌘ / Ctrl', () => expect(shortcutAction({ key: 'b', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBeNull());
});

describe('diffRange / applyFormat', () => {
  it('finds the smallest replacement', () => {
    expect(diffRange('abc', 'aXc')).toEqual({ from: 1, to: 2, insert: 'X' });
    expect(diffRange('say hello now', 'say **hello** now')).toEqual({ from: 4, to: 9, insert: '**hello**' });
    expect(diffRange('same', 'same')).toEqual({ from: 4, to: 4, insert: '' });
  });
  it('applyFormat dispatches', () => expect(applyFormat(at('[x]'), 'bold').text).toBe('**x**'));
});

describe('code blocks while typing', () => {
  it('knows where the caret is', () => {
    expect(fenceState('hello', 5)).toBe('outside');
    expect(fenceState('```ts', 5)).toBe('opening');
    expect(fenceState('```\nlet x', 9)).toBe('inside');
    expect(fenceState('```\nlet x\n```', 13)).toBe('outside'); // the closing fence line
    expect(fenceState('```\nx\n```\nafter', 17)).toBe('outside');
  });
  it('Enter after a typed opening fence starts the block and closes it', () => {
    const r = enterInFence(at('```ts|'))!;
    expect(r.text).toBe('```ts\n\n```');
    expect(r.start).toBe(6);
  });
  it('does not add a second closing fence when the block already has one', () => {
    expect(enterInFence(at('```|\ncode\n```'))!.text).toBe('```\n\ncode\n```');
  });
  it('inside a block Enter is a plain new line; outside it is not handled', () => {
    expect(enterInFence(at('```\nlet x|\n```'))!.text).toBe('```\nlet x\n\n```');
    expect(enterInFence(at('plain|'))).toBeNull();
    expect(enterInFence(at('```\nx\n```|'))).toBeNull();
  });
});

describe('insertQuote', () => {
  it('into an empty box: the quote, a blank line, the caret ready for the reply', () => {
    const r = insertQuote({ text: '', start: 0, end: 0 }, '> said');
    expect(r.text).toBe('> said\n\n');
    expect(r.start).toBe(r.text.length);
  });
  it('after text already typed: on its own paragraph', () => {
    expect(insertQuote({ text: 'so', start: 2, end: 2 }, '> said').text).toBe('so\n\n> said\n\n');
    expect(insertQuote({ text: 'so\n', start: 3, end: 3 }, '> said').text).toBe('so\n\n> said\n\n');
    expect(insertQuote({ text: 'so\n\n', start: 4, end: 4 }, '> said').text).toBe('so\n\n> said\n\n');
  });
  it('in the middle of text: the rest follows after the quote', () => {
    const r = insertQuote({ text: 'ab', start: 1, end: 1 }, '> q');
    expect(r.text).toBe('a\n\n> q\n\nb');
    expect(r.start).toBe(r.text.indexOf('b'));
  });
});

describe('review fixes', () => {
  it('toggleLinePrefix never gives a selection that ends before it starts (a negative end selected the whole message)', () => {
    const r = toggleLinePrefix({ text: '- a', start: 1, end: 1 }, 'ul');
    expect(r.start).toBeGreaterThanOrEqual(0);
    expect(r.end).toBeGreaterThanOrEqual(r.start);
  });
  it('Bold on a selection that already holds several bold parts takes them all off', () => {
    expect(toggleWrap(at('[**a** and **b**]'), '**').text).toBe('a and b');
  });
  it('Shift+Enter on an empty marker with text after the caret is an ordinary new line', () => {
    expect(continueList(at('- |rest'))).toBeNull();
    expect(continueList(at('- one\n- |'))?.text).toBe('- one\n');
  });
  it('insertQuote never swallows a selection: the quote goes after it', () => {
    const r = insertQuote({ text: 'abcd', start: 1, end: 3 }, '> q');
    expect(r.text.startsWith('abc\n\n> q')).toBe(true);
    expect(r.text.endsWith('d')).toBe(true);
  });
  it('fence parity with the chat: a longer fence is closed only by a bare fence at least as long', () => {
    expect(fenceState('````\ncode\n```js\nx', 17)).toBe('inside'); // ```js does not close a 4-backtick block
    expect(fenceState('````\ncode\n```\nx', 15)).toBe('inside'); // three backticks do not close four
    expect(fenceState('```\ncode\n````\nx', 16)).toBe('outside');
  });
});
