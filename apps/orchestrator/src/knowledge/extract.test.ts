import { mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_BYTES, documentCacheSize, readDocumentText } from './extract';

let dir: string;
beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'ext-'))));
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('readDocumentText', () => {
  it('extracts once per file version, and again after the file changes', async () => {
    const f = join(dir, 'a.md');
    await writeFile(f, '# one');
    const before = documentCacheSize();
    expect(await readDocumentText(f)).toContain('one');
    expect(documentCacheSize()).toBe(before + 1);
    expect(await readDocumentText(f)).toContain('one');
    expect(documentCacheSize()).toBe(before + 1); // served from the cache
    await writeFile(f, '# two');
    await utimes(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(await readDocumentText(f)).toContain('two');
    expect(documentCacheSize()).toBe(before + 2);
  });

  it('refuses a file over 10 MB before reading it', async () => {
    const f = join(dir, 'big.txt');
    await writeFile(f, '');
    await truncate(f, MAX_DOCUMENT_BYTES + 1);
    await expect(readDocumentText(f)).rejects.toThrow(/too large/);
  });

  it('refuses a directory', async () => {
    await expect(readDocumentText(dir)).rejects.toThrow(/not a file/);
  });
});
