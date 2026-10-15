import { describe, expect, it } from 'vitest';
import { splitForTransport } from './split-text';

describe('splitForTransport', () => {
  it('leaves a short text alone (and a non-finite limit means no limit)', () => {
    expect(splitForTransport('hello', 4096)).toEqual(['hello']);
    expect(splitForTransport('x'.repeat(10_000), Infinity)).toEqual(['x'.repeat(10_000)]);
  });

  it('prefers paragraph breaks, then line breaks, then spaces', () => {
    const paras = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}\n\n${'c'.repeat(50)}`;
    expect(splitForTransport(paras, 120)).toEqual(['a'.repeat(50) + '\n\n' + 'b'.repeat(50), 'c'.repeat(50)]);
    const lines = `${'a'.repeat(50)}\n${'b'.repeat(50)}\n${'c'.repeat(50)}`;
    expect(splitForTransport(lines, 120)).toEqual(['a'.repeat(50) + '\n' + 'b'.repeat(50), 'c'.repeat(50)]);
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const parts = splitForTransport(words, 50);
    expect(parts.every((p) => p.length <= 50)).toBe(true);
    expect(parts.join(' ')).toBe(words);
  });

  it('keeps every piece within the limit and loses no characters', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}: ${'x'.repeat(i % 37)}${i % 5 === 0 ? '\n\n' : '\n'}`).join('');
    const parts = splitForTransport(text, 4096);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  it('cuts a giant word at the limit without splitting a surrogate pair', () => {
    const emoji = '😀'; // two UTF-16 units
    const text = emoji.repeat(100); // 200 units, no whitespace
    const parts = splitForTransport(text, 51); // an odd limit would fall between the halves of a pair
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(51);
      expect(p.length % 2).toBe(0);
      expect([...p].every((ch) => ch === emoji)).toBe(true);
    }
    expect(parts.join('')).toBe(text);
  });

  it('does not leave a crumb: a boundary too close to the start is ignored in favour of a later one', () => {
    const text = `ab\n${'c'.repeat(100)} ${'d'.repeat(100)}`;
    const parts = splitForTransport(text, 120);
    expect(parts[0]).toBe(`ab\n${'c'.repeat(100)}`);
    expect(parts[1]).toBe('d'.repeat(100));
  });

  it('keeps indentation after a line cut and never emits empty pieces', () => {
    const text = `${'a'.repeat(100)}\n\n\n    indented ${'b'.repeat(100)}`;
    const parts = splitForTransport(text, 110);
    expect(parts[0]).toBe('a'.repeat(100));
    expect(parts[1]!.startsWith('    indented')).toBe(true);
    expect(parts.every((p) => p.length > 0)).toBe(true);
  });
});
