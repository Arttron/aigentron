import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inlineBlock, isInlineTextName, readInlineFiles } from './inline-attachments';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inl-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('inline attachments for chat agents', () => {
  it('knows text names', () => {
    expect(isInlineTextName('prompt.md')).toBe(true);
    expect(isInlineTextName('DATA.CSV')).toBe(true);
    expect(isInlineTextName('photo.jpg')).toBe(false);
    expect(isInlineTextName('report.pdf')).toBe(false);
  });

  it('reads text files, skips others and binary, marks cuts', async () => {
    await writeFile(join(dir, 'a.md'), '# Prompt\r\nline');
    await writeFile(join(dir, 'b.png'), 'x');
    await writeFile(join(dir, 'c.txt'), 'bin\u0000ary');
    await writeFile(join(dir, 'long.txt'), 'x'.repeat(50_000));
    const files = await readInlineFiles([join(dir, 'a.md'), join(dir, 'b.png'), join(dir, 'c.txt'), join(dir, 'long.txt'), join(dir, 'missing.md')]);
    expect(files.map((f) => f.name)).toEqual(['a.md', 'long.txt']);
    expect(files[0]).toMatchObject({ text: '# Prompt\nline', truncated: false });
    expect(files[1]!.text.length).toBe(12_000);
    expect(files[1]!.truncated).toBe(true);
  });

  it('keeps to the total budget', async () => {
    for (const n of ['1', '2', '3']) await writeFile(join(dir, `${n}.txt`), 'y'.repeat(11_000));
    const files = await readInlineFiles(['1', '2', '3'].map((n) => join(dir, `${n}.txt`)), 11_000, 24_000);
    expect(files.reduce((a, f) => a + f.text.length, 0)).toBeLessThanOrEqual(24_000);
    expect(files.length).toBe(3);
    expect(files[2]!.truncated).toBe(true);
  });

  it('renders a block per file, empty for none', () => {
    expect(inlineBlock([])).toBe('');
    const b = inlineBlock([{ name: 'p.md', text: 'hi', truncated: true }]);
    expect(b).toContain('attached file: p.md (cut');
    expect(b).toContain('hi\n--- end of p.md ---');
  });
});
