import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexImagesDir, listGeneratedImages } from './codex-images';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'cimg-'));
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('codex generated images', () => {
  it('lives in the run\'s own codex-home', () => {
    expect(codexImagesDir('/data/agent', 't1')).toBe('/data/agent/runs/t1/codex-home/generated_images');
  });

  it('finds pictures at any depth, oldest first, ignores other files and a missing folder', async () => {
    const dir = join(base, 'generated_images');
    await mkdir(join(dir, 'sess-1'), { recursive: true });
    await writeFile(join(dir, 'sess-1', 'b.png'), 'x');
    await writeFile(join(dir, 'a.JPG'), 'x');
    await writeFile(join(dir, 'notes.txt'), 'x');
    await utimes(join(dir, 'a.JPG'), 1000, 1000);
    await utimes(join(dir, 'sess-1', 'b.png'), 2000, 2000);
    expect(await listGeneratedImages(dir)).toEqual([join(dir, 'a.JPG'), join(dir, 'sess-1', 'b.png')]);
    expect(await listGeneratedImages(join(base, 'nope'))).toEqual([]);
  });
});
