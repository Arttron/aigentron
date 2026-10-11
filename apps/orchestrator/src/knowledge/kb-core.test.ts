import { describe, expect, it } from 'vitest';
import { Bm25Index, chunkText, cleanChunking, cutChars, decodeVector, encodeVector, extractText, fuseRanks, htmlToText, stem, tokenize, topBySimilarity } from './kb-core';

describe('tokenize', () => {
  it('lowercases, stems English and Russian, drops stop words', () => {
    expect(tokenize('The Running of the Cats')).toEqual(['runn', 'cat']);
    expect(stem('curing')).toBe(stem('cure'));
    expect(tokenize('Штукатурка стен')).toEqual(['штука', 'стен']);
    expect(tokenize('штукатурки')).toEqual(['штука']);
  });
  it('keeps numbers', () => {
    expect(tokenize('GOST 2.105-95')).toContain('105');
  });
});

describe('chunkText', () => {
  const doc = '# Codes\n\n## Walls\n\n1. Plaster must be 10 mm thick.\n\n2. Primer before paint.\n\n## Floors\n\nScreed needs 28 days to cure before tiles are laid on it, always.';
  it('section: headings give a path, clauses start new pieces, tiny ones merge', () => {
    const c = chunkText(doc, { strategy: 'section', minChars: 0, maxChars: 3000 });
    expect(c.map((x) => x.heading)).toEqual(['Codes > Walls', 'Codes > Walls', 'Codes > Floors']);
    expect(c[0]!.text).toContain('Plaster');
    expect(c[1]!.text).toContain('Primer');
    const merged = chunkText(doc, { strategy: 'section', minChars: 400 });
    expect(merged.length).toBeLessThan(c.length);
  });
  it('paragraph packs up to maxChars; chars windows overlap and snap to sentences', () => {
    const para = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} `.repeat(30)).join('\n\n');
    const p = chunkText(para, { strategy: 'paragraph', maxChars: 700 });
    expect(p.length).toBeGreaterThan(3);
    expect(p.every((x) => x.text.length <= 700)).toBe(true);
    const text = 'One sentence here. '.repeat(100);
    const w = cutChars(text, 300, 60);
    expect(w.length).toBeGreaterThan(5);
    expect(w.every((x) => x.length <= 300)).toBe(true);
    expect(w[0]!.endsWith('.')).toBe(true);
  });
  it('splits an oversize section and clamps odd settings', () => {
    const big = `# T\n\n${'word '.repeat(2000)}`;
    const c = chunkText(big, { strategy: 'section', maxChars: 1000 });
    expect(c.length).toBeGreaterThan(5);
    expect(c.every((x) => x.heading === 'T' && x.text.length <= 1000)).toBe(true);
    expect(cleanChunking({ maxChars: 5, overlap: 99999, strategy: 'x' as never })).toMatchObject({ maxChars: 300, strategy: 'section', overlap: 150 });
    expect(chunkText('   ')).toEqual([]);
  });
});

describe('Bm25Index', () => {
  const idx = new Bm25Index();
  idx.add('Walls', 'Plaster must be ten millimetres thick on interior walls.');
  idx.add('Floors', 'Screed needs twenty eight days to cure before tiles.');
  idx.add('', 'Штукатурка стен выполняется в два слоя.');
  it('finds the relevant chunk, headings help, stemming works', () => {
    expect(idx.search('plastering walls', 3)[0]!.idx).toBe(0);
    expect(idx.search('tile curing', 3)[0]!.idx).toBe(1);
    expect(idx.search('штукатурки', 3)[0]!.idx).toBe(2);
    expect(idx.search('zzzz', 3)).toEqual([]);
  });
  it('can restrict to allowed chunks', () => {
    expect(idx.search('walls', 5, (i) => i !== 0).every((s) => s.idx !== 0)).toBe(true);
  });
});

describe('vectors', () => {
  it('round-trips and ranks by similarity; fusion rewards agreement', () => {
    const a = decodeVector(encodeVector([3, 4, 0]));
    expect(a[0]).toBeCloseTo(0.6);
    expect(a[1]).toBeCloseTo(0.8);
    const vs = [decodeVector(encodeVector([1, 0])), decodeVector(encodeVector([0, 1])), null];
    const top = topBySimilarity(decodeVector(encodeVector([0.1, 1])), vs, 5);
    expect(top[0]!.idx).toBe(1);
    expect(top.length).toBe(2);
    const fused = fuseRanks([[{ idx: 5, score: 9 }, { idx: 1, score: 8 }], [{ idx: 1, score: 0.9 }, { idx: 7, score: 0.5 }]], 3);
    expect(fused[0]!.idx).toBe(1);
  });
});

describe('extraction', () => {
  it('reads text-like files and strips html', () => {
    expect(extractText('a.md', Buffer.from('# Hi'))).toBe('# Hi');
    expect(extractText('a.pdf', Buffer.from('x'))).toBeNull();
    expect(htmlToText('<h1>T</h1><script>x()</script>')).toBe('T');
    expect(htmlToText('<p>one</p><p>two &amp; three</p>')).toContain('two & three');
  });
});

describe('robustness (review findings)', () => {
  it('numbered markers need a capital and at most 3 digits — years and lower-case list items are text', () => {
    const doc = '# T\n\n2024. The company grew a lot in that year and needed more people.\n\n1. open the box and look inside.\n\n10) items were sold during the sale.\n\nPart 2 is better than part 1.';
    expect(chunkText(doc, { strategy: 'section', minChars: 0 }).length).toBe(1);
    const real = '# T\n\n1. Plaster must be 10 mm.\n\n2. Primer before paint.\n\nArticle 4. Liability stays with the owner.';
    expect(chunkText(real, { strategy: 'section', minChars: 0 }).length).toBe(3);
  });
  it('every chunk fits maxChars and no text is lost, whatever the strategy', () => {
    const words = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(' ');
    for (const strategy of ['section', 'paragraph', 'chars'] as const) {
      for (const maxChars of [300, 800, 3000]) {
        const chunks = chunkText(`# H\n\n${words}\n\n${words}`, { strategy, maxChars, overlap: 100, minChars: 50 });
        expect(chunks.every((c) => c.text.length <= maxChars + 100)).toBe(true);
        const all = chunks.map((c) => c.text).join(' ');
        expect(all).toContain('w0');
        expect(all).toContain('w1199');
      }
    }
  });
  it('cutChars always terminates, even when the overlap is as big as the window', () => {
    expect(cutChars('a '.repeat(500), 100, 100).length).toBeGreaterThan(5);
  });
  it('indexes Chinese / Japanese text as character pairs', () => {
    expect(tokenize('日本語のテキスト')).toContain('日本');
    const idx = new Bm25Index();
    idx.add('', '今日は天気がいいです');
    idx.add('', 'Totally unrelated English text');
    expect(idx.search('天気', 2)[0]!.idx).toBe(0);
  });
  it('a corrupt or foreign-sized vector does not break ranking', () => {
    expect(() => decodeVector('abc')).toThrow();
    const good = decodeVector(encodeVector([1, 0, 0]));
    expect(topBySimilarity(decodeVector(encodeVector([1, 0])), [good, null], 3)[0]!.idx).toBe(0);
  });
});
