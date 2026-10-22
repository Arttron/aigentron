import { mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import type { ImageOptimizer } from '../media/image-optimizer.service';
import { MAX_VIDEO_UPLOAD_BYTES, TASK_QUOTA_BYTES, AttachmentsService, limitFor, sanitize, tooBigMessage } from './attachments.service';

let base: string;
let svc: AttachmentsService;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'attsave-'));
  await mkdir(join(base, 'agent', 'resources'), { recursive: true });
  svc = new AttachmentsService({ attachmentsDir: join(base, 'attachments'), workspaceDir: join(base, 'ws'), agentDir: join(base, 'agent') } as AppConfigService, { optimize: async (path: string) => ({ path, changed: false, size: 0 }) } as unknown as ImageOptimizer);
});
afterEach(() => rm(base, { recursive: true, force: true }));

const body = (s: string) => Readable.from([Buffer.from(s)]);

describe('save', () => {
  it('stores the file, leaves no temp file, and never overwrites a same-named one (also when two uploads race)', async () => {
    const [a, b] = await Promise.all([svc.save('t1', 'notes.txt', body('A')), svc.save('t1', 'notes.txt', body('B'))]);
    expect([a.name, b.name].sort()).toEqual(['notes-1.txt', 'notes.txt']);
    expect((await readdir(svc.dir('t1'))).sort()).toEqual(['notes-1.txt', 'notes.txt']); // no `.part` left
    expect([await readFile(join(svc.dir('t1'), 'notes.txt'), 'utf8'), await readFile(join(svc.dir('t1'), 'notes-1.txt'), 'utf8')].sort()).toEqual(['A', 'B']);
  });

  it('a failed upload leaves nothing behind', async () => {
    const bad = new Readable({ read() { this.destroy(new Error('connection lost')); } });
    await expect(svc.save('t1', 'x.txt', bad)).rejects.toThrow(/connection lost/);
    expect((await readdir(svc.dir('t1'))).filter((n) => !n.startsWith('.links'))).toEqual([]);
  });

  it('does not pick a name a link already uses', async () => {
    await mkdir(join(base, 'ws', 'deliverables'), { recursive: true });
    await writeFile(join(base, 'ws', 'deliverables', 'report.md'), 'linked');
    await svc.link('t1', join(base, 'ws', 'deliverables', 'report.md'));
    expect((await svc.save('t1', 'report.md', body('mine'))).name).toBe('report-1.md');
  });

  it('refuses an upload that already declares more than the limit, with a plain message', async () => {
    await expect(svc.save('t1', 'walk.mp4', body('x'), MAX_VIDEO_UPLOAD_BYTES + 1)).rejects.toThrow(/larger than 95 MB.*Trim it/);
    await expect(svc.save('t1', 'big.pdf', body('x'), 11 * 1024 * 1024)).rejects.toThrow(/larger than 10 MB/);
    expect(limitFor('mp4')).toBe(95 * 1024 * 1024);
    expect(tooBigMessage('webm')).toContain('95 MB');
  });

  it('enforces the per-task quota', async () => {
    await mkdir(svc.dir('t1'), { recursive: true });
    await truncate(join(svc.dir('t1'), 'old.bin'), 0).catch(() => writeFile(join(svc.dir('t1'), 'old.bin'), ''));
    await truncate(join(svc.dir('t1'), 'old.bin'), TASK_QUOTA_BYTES - 3); // sparse: costs no disk
    await expect(svc.save('t1', 'a.txt', body('12345'), 5)).rejects.toThrow(/limit per task/);
    await expect(svc.save('t1', 'b.txt', body('12345'))).rejects.toThrow(/exceed/); // no Content-Length: caught while streaming
  });

  it('counts only own files in usedBytes', async () => {
    await svc.save('t1', 'a.txt', body('12345'));
    expect(await svc.usedBytes('t1')).toBe(5);
  });
});

describe('names, types and limits', () => {
  it('keeps unicode names, strips paths and odd characters, never a leading dot', async () => {
    expect(sanitize('кухня 2.jpg')).toBe('кухня 2.jpg');
    expect(sanitize('写真.PNG')).toBe('写真.PNG');
    expect(sanitize('../../etc/passwd')).toBe('passwd');
    expect(sanitize('..')).toBe('file');
    expect(sanitize('.')).toBe('file');
    expect(sanitize('a/b\\c:d*e.txt')).toBe('b_c_d_e.txt'); // only `/` is a separator; the rest becomes `_`
    expect(sanitize('.links.json')).toBe('links.json');
    expect(sanitize('')).toBe('file');
    expect(sanitize('x'.repeat(200)).length).toBe(120);
  });

  it('looks up mime and limits by extension regardless of case', async () => {
    expect(limitFor('MP4')).toBe(MAX_VIDEO_UPLOAD_BYTES);
    expect(limitFor('pdf')).toBe(10 * 1024 * 1024);
    const m = await svc.save('t1', 'Photo.PNG', body('notapng'));
    expect(m.mime).toBe('image/png');
    expect((await svc.list('t1'))[0]).toMatchObject({ name: 'Photo.PNG', mime: 'image/png', size: 7 });
    expect(await svc.save('t1', 'notes.MD', body('x'))).toMatchObject({ mime: 'text/markdown' });
    expect(await svc.save('t1', 'blob.xyz', body('x'))).toMatchObject({ mime: 'application/octet-stream' });
  });

  it('refuses a stream over the limit while reading it and leaves nothing behind', async () => {
    const chunks = Array.from({ length: 11 }, () => Buffer.alloc(1024 * 1024));
    await expect(svc.save('t1', 'big.pdf', Readable.from(chunks))).rejects.toThrow(/larger than 10 MB/);
    expect(await readdir(svc.dir('t1'))).toEqual([]);
  });

  it('serves images/pdf/playable video inline, everything else as a download; `..` and dot names are not files', async () => {
    await svc.save('t1', 'a.PDF', body('%PDF'));
    await svc.save('t1', 'a.docx', body('x'));
    await svc.save('t1', 'a.mkv', body('x'));
    expect(await svc.filePath('t1', 'a.PDF')).toMatchObject({ inline: true, mime: 'application/pdf', name: 'a.PDF' });
    expect(await svc.filePath('t1', 'a.docx')).toMatchObject({ inline: false });
    expect(await svc.filePath('t1', 'a.mkv')).toMatchObject({ inline: false, mime: 'video/x-matroska' });
    await expect(svc.filePath('t1', '..')).rejects.toThrow(/not found/);
    await expect(svc.filePath('t1', '.')).rejects.toThrow(/not found/);
    await expect(svc.filePath('t1', '../t1/a.docx')).resolves.toMatchObject({ name: 'a.docx' }); // the path part is dropped, the name stays
  });

  it('never serves a symlink that leads out of the task folder', async () => {
    await writeFile(join(base, 'secret.txt'), 'x');
    await mkdir(svc.dir('t1'), { recursive: true });
    await symlink(join(base, 'secret.txt'), join(svc.dir('t1'), 'leak.txt'));
    await expect(svc.filePath('t1', 'leak.txt')).rejects.toThrow(/not found/);
    expect((await svc.list('t1')).map((m) => m.name)).toEqual([]);
  });
});

describe('adopt / writeImage', () => {
  it('adopt refuses a symlink and a hard-linked file', async () => {
    await mkdir(join(base, 'ws'), { recursive: true });
    await writeFile(join(base, 'secret.png'), 'x');
    await symlink(join(base, 'secret.png'), join(base, 'ws', 'sym.png'));
    await expect(svc.adopt('t1', join(base, 'ws', 'sym.png'))).rejects.toThrow(/plain picture/);
    const { link } = await import('node:fs/promises');
    await link(join(base, 'secret.png'), join(base, 'ws', 'hard.png'));
    await expect(svc.adopt('t1', join(base, 'ws', 'hard.png'))).rejects.toThrow(/plain picture/);
  });

  it('adopting the same picture twice (even under another name) gives the file that is already there, not a second copy', async () => {
    await mkdir(join(base, 'ws'), { recursive: true });
    await writeFile(join(base, 'ws', 'a.gif'), 'GIF89a-same-bytes');
    await writeFile(join(base, 'ws', 'b.gif'), 'GIF89a-same-bytes');
    await writeFile(join(base, 'ws', 'c.gif'), 'GIF89a-other-bytes');
    const first = await svc.adopt('t1', join(base, 'ws', 'a.gif'));
    expect(await svc.adopt('t1', join(base, 'ws', 'a.gif'))).toBe(first);
    expect(await svc.adopt('t1', join(base, 'ws', 'b.gif'))).toBe(first);
    const other = await svc.adopt('t1', join(base, 'ws', 'c.gif'));
    expect(other).not.toBe(first);
    expect((await svc.list('t1')).map((m) => m.name).sort()).toEqual([first, other].sort());
  });

  it('writeImage refuses an oversized base64 string before decoding it', async () => {
    await expect(svc.writeImage('t1', 'shot.png', 'A'.repeat(15 * 1024 * 1024))).rejects.toThrow(/exceeds/);
  });

  it('stores a non-Latin name as plain ASCII and keeps the original for display and download', async () => {
    const meta = await svc.save('t1', 'кухня 2.jpg', body('jpg-bytes'));
    expect(meta.name).toMatch(/^kukhnya-2/);
    expect(meta.name).toMatch(/^[\x20-\x7e]+$/);
    expect(meta.originalName).toMatch(/^кухня 2/);
    const listed = (await svc.list('t1')).find((m) => m.name === meta.name);
    expect(listed?.originalName).toMatch(/^кухня 2/);
    const f = await svc.filePath('t1', meta.name);
    expect(f.name).toBe(meta.name);
    expect(f.downloadName).toMatch(/^кухня 2/);
  });

  it('a plain ASCII name has no separate original; two uploads of the same Cyrillic name do not clash', async () => {
    const plain = await svc.save('t1', 'plan.txt', body('x'));
    expect(plain.originalName).toBeUndefined();
    const a = await svc.save('t1', 'отчёт.txt', body('1'));
    const b = await svc.save('t1', 'отчёт.txt', body('2'));
    expect(a.name).not.toBe(b.name);
    expect(a.originalName).toBe('отчёт.txt');
    expect(b.originalName).toBe('отчёт.txt');
  });
});
