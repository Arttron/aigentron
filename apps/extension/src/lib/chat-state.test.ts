import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript modules (the extension has no build step for its own sources)
import { PENDING_TTL_MS, newPending, reconcilePending, waiting } from './chat-state.js';
// @ts-expect-error plain JavaScript module
import { QUOTE_MAX, quoteText } from './quote.js';
// @ts-expect-error plain JavaScript module
import { continueList, diffRange, insertQuote, pasteLinkOverSelection, shortcutAction, toggleWrap } from './md-edit.js';

describe('pending messages', () => {
  it('a message the conversation has echoed stops being pending, one echo per message', () => {
    const a = newPending('ok', 1000);
    const b = newPending('ok', 1001);
    const c = newPending('later', 1002);
    expect(reconcilePending([a, b, c], ['ok'], 2000)).toEqual([b, c]);
    expect(reconcilePending([a, b, c], ['ok', ' ok '], 2000)).toEqual([c]);
  });
  it('an echo that never comes does not keep it for ever', () => {
    const p = newPending('x', 1000);
    expect(reconcilePending([p], [], 1000 + PENDING_TTL_MS + 1)).toEqual([]);
  });
});

describe('what waits under the conversation', () => {
  const base = { pending: [], status: 'running', echoedTexts: [] as string[] };
  it('queued messages first, then the ones still being sent', () => {
    const w = waiting({ ...base, queue: [{ id: 'q1', text: 'second' }], pending: [{ id: 'p1', text: 'third', at: 1 }] });
    expect(w).toEqual([{ kind: 'queued', id: 'q1', text: 'second' }, { kind: 'sending', id: 'p1', text: 'third' }]);
  });
  it('a message that is already in the queue is not shown twice (the local "sending" one is dropped)', () => {
    const w = waiting({ ...base, queue: [{ id: 'q1', text: 'same text' }], pending: [{ id: 'p1', text: ' same  text ', at: 1 }] });
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('queued');
  });
  it('a message whose run waits to start is shown as starting; once running only until the conversation echoes it', () => {
    const q = [{ id: 's', text: 'go', starting: true }];
    expect(waiting({ ...base, status: 'queued', queue: q, echoedTexts: ['go'] })).toHaveLength(1);
    expect(waiting({ ...base, status: 'running', queue: q, echoedTexts: [] })[0].kind).toBe('starting');
    expect(waiting({ ...base, status: 'running', queue: q, echoedTexts: ['go'] })).toEqual([]);
  });
});

describe('quoteText', () => {
  it('> on every line, a bare > on empty lines; empty text is no quote', () => {
    expect(quoteText('one\n\ntwo')).toBe('> one\n>\n> two');
    expect(quoteText('  ')).toBe('');
  });
  it('very long text is cut at a paragraph, with a note', () => {
    const para = 'word '.repeat(200).trim();
    const q = quoteText(Array.from({ length: 12 }, () => para).join('\n\n'));
    expect(q.length).toBeLessThan(QUOTE_MAX + 40);
    expect(q.endsWith('> [… cut]')).toBe(true);
  });
});

describe('the message box edits', () => {
  it('bold on a selection, and off again', () => {
    expect(toggleWrap({ text: 'say hello now', start: 4, end: 9 }, '**')).toEqual({ text: 'say **hello** now', start: 6, end: 11 });
    expect(toggleWrap({ text: 'say **hello** now', start: 6, end: 11 }, '**').text).toBe('say hello now');
  });
  it('a quote goes after the caret on its own paragraph; the caret waits below it', () => {
    const r = insertQuote({ text: 'so', start: 2, end: 2 }, '> said');
    expect(r.text).toBe('so\n\n> said\n\n');
    expect(r.start).toBe(r.text.length);
    expect(insertQuote({ text: '', start: 0, end: 0 }, '> q').text).toBe('> q\n\n');
  });
  it('a selection is never swallowed by a quote', () => expect(insertQuote({ text: 'abcd', start: 1, end: 3 }, '> q').text.startsWith('abc\n\n> q')).toBe(true));
  it('Shift+Enter continues a list, an empty item ends it', () => {
    expect(continueList({ text: '- one', start: 5, end: 5 }).text).toBe('- one\n- ');
    expect(continueList({ text: '- one\n- ', start: 8, end: 8 }).text).toBe('- one\n');
    expect(continueList({ text: 'plain', start: 5, end: 5 })).toBeNull();
  });
  it('an address pasted over a word becomes its link', () => {
    expect(pasteLinkOverSelection({ text: 'see docs', start: 4, end: 8 }, 'https://e.com/a').text).toBe('see [docs](https://e.com/a)');
    expect(pasteLinkOverSelection({ text: 'see ', start: 4, end: 4 }, 'https://e.com')).toBeNull();
  });
  it('shortcuts and the smallest replacement', () => {
    expect(shortcutAction({ key: 'b', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe('bold');
    expect(shortcutAction({ key: 'b', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBeNull();
    expect(diffRange('say hello now', 'say **hello** now')).toEqual({ from: 4, to: 9, insert: '**hello**' });
  });
});
