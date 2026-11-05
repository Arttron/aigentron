import { describe, expect, it, vi } from 'vitest';
import { QUOTE_MAX, emitQuote, onQuote, quoteText } from './quote';

describe('quoteText', () => {
  it('puts > on every line, a bare > on empty lines', () => expect(quoteText('one\n\ntwo')).toBe('> one\n>\n> two'));
  it('trims, and an empty text is no quote', () => {
    expect(quoteText('  hi  \n')).toBe('> hi');
    expect(quoteText('   ')).toBe('');
  });
  it('keeps markdown as it is (the quote is the raw text)', () => expect(quoteText('**b** and `c`\n- item')).toBe('> **b** and `c`\n> - item'));
  it('cuts a very long text at a paragraph, with a note', () => {
    const para = 'word '.repeat(200).trim();
    const long = Array.from({ length: 12 }, () => para).join('\n\n');
    const q = quoteText(long);
    expect(q.length).toBeLessThan(QUOTE_MAX + 40);
    expect(q.endsWith('> [… cut]')).toBe(true);
  });
});

describe('the quote bus', () => {
  it('hands a quote to the box of that scope only, and says whether somebody took it', () => {
    const mine = vi.fn();
    const other = vi.fn();
    const off1 = onQuote('task:1', mine);
    const off2 = onQuote('task:2', other);
    expect(emitQuote('task:1', '> hi')).toBe(true);
    expect(mine).toHaveBeenCalledWith('> hi');
    expect(other).not.toHaveBeenCalled();
    off1();
    expect(emitQuote('task:1', '> hi')).toBe(false);
    off2();
  });
});
