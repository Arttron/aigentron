import { mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import type { ImageOptimizer } from '../media/image-optimizer.service';
import { MAX_VIDEO_UPLOAD_BYTES, TASK_QUOTA_BYTES, AttachmentsService, limitFor, tooBigMessage } from './attachments.service';

let base: string;
let svc: AttachmentsService;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'attsave-'));
  await mkdir(join(base, 'agent', 'resources'), { recursive: true });
  svc = new AttachmentsService({ attachmentsDir: join(base, 'attachments'), workspaceDir: join(base, 'ws'), agentDir: join(base, 'agent') } as AppConfigService, {} as ImageOptimizer);
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

  it('writeImage refuses an oversized base64 string before decoding it', async () => {
    await expect(svc.writeImage('t1', 'shot.png', 'A'.repeat(15 * 1024 * 1024))).rejects.toThrow(/exceeds/);
  });
});
