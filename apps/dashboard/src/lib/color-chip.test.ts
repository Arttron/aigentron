import { describe, expect, it } from 'vitest';
import { contrastText, cssColor, findColors, parseColor } from './color-chip';

describe('parseColor', () => {
  it('hex in every length', () => {
    expect(parseColor('#f80')).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor('#FF8800')).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor('#ff880080')).toEqual({ r: 255, g: 136, b: 0, a: 0.5 });
    expect(parseColor('#f808')).toEqual({ r: 255, g: 136, b: 0, a: 0.53 });
  });
  it('rgb / rgba / hsl in both syntaxes', () => {
    expect(parseColor('rgb(255, 136, 0)')).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor('rgb(255 136 0 / 50%)')).toEqual({ r: 255, g: 136, b: 0, a: 0.5 });
    expect(parseColor('rgba(0,0,0,.25)')).toEqual({ r: 0, g: 0, b: 0, a: 0.25 });
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('hsl(120deg 100% 25%)')).toEqual({ r: 0, g: 128, b: 0, a: 1 });
  });
  it('refuses what is not a colour', () => {
    for (const v of ['#12', '#12345', '#gg0000', 'rgb(300, 0, 0)', 'rgb(1, 2)', 'hsl(0, 100, 50)', 'red', 'rgb(a, b, c)', '']) expect(parseColor(v), v).toBeNull();
  });
});

describe('contrastText', () => {
  it('black on light, white on dark', () => {
    expect(contrastText({ r: 255, g: 255, b: 0, a: 1 })).toBe('#000000');
    expect(contrastText({ r: 255, g: 255, b: 255, a: 1 })).toBe('#000000');
    expect(contrastText({ r: 0, g: 0, b: 128, a: 1 })).toBe('#ffffff');
    expect(contrastText({ r: 0, g: 0, b: 0, a: 1 })).toBe('#ffffff');
  });
  it('picks the better side for the awkward middle colours', () => {
    expect(contrastText({ r: 255, g: 0, b: 0, a: 1 })).toBe('#000000'); // pure red: black wins by contrast ratio
    expect(contrastText({ r: 0, g: 128, b: 0, a: 1 })).toBe('#ffffff');
  });
  it('a faint transparent colour is judged over white', () => {
    expect(contrastText({ r: 0, g: 0, b: 0, a: 0.1 })).toBe('#000000');
  });
});

describe('findColors', () => {
  it('finds colours in a sentence', () => {
    const t = 'use #ff8800 or rgb(10, 20, 30), not #zzz';
    const f = findColors(t);
    expect(f.map((x) => x.text)).toEqual(['#ff8800', 'rgb(10, 20, 30)']);
    expect(t.slice(f[0]!.start, f[0]!.end)).toBe('#ff8800');
  });
  it('short digit-only hex is an issue number, not a colour; 6 digits always are', () => {
    expect(findColors('see #123 and #1234')).toEqual([]);
    expect(findColors('fix #fa0').length).toBe(1);
    expect(findColors('#123456').length).toBe(1);
  });
  it('not inside URLs, anchors, entities or words', () => {
    expect(findColors('https://x.io/page#ff8800')).toEqual([]);
    expect(findColors('&#ff8800;')).toEqual([]);
    expect(findColors('abc#ff8800')).toEqual([]);
    expect(findColors('file.#ff8800')).toEqual([]);
  });
  it('the css is rebuilt from numbers', () => {
    expect(cssColor({ r: 1, g: 2, b: 3, a: 1 })).toBe('rgb(1, 2, 3)');
    expect(cssColor({ r: 1, g: 2, b: 3, a: 0.5 })).toBe('rgba(1, 2, 3, 0.5)');
  });
});
