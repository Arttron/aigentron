import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import type { ImageOptimizer } from '../media/image-optimizer.service';
import { AttachmentsService } from './attachments.service';

let base: string;
let svc: AttachmentsService;
const ws = () => join(base, 'workspace');

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'att-'));
  await mkdir(join(ws(), 'deliverables'), { recursive: true });
  await mkdir(join(base, 'agent', 'resources'), { recursive: true });
  svc = new AttachmentsService({ attachmentsDir: join(base, 'attachments'), workspaceDir: ws(), agentDir: join(base, 'agent') } as AppConfigService, {} as ImageOptimizer);
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('linked attachments (no copy)', () => {
  it('lists a linked file next to the task\'s own files and serves it from where it lives', async () => {
    await mkdir(svc.dir('t1'), { recursive: true });
    await writeFile(join(svc.dir('t1'), 'photo.jpg'), 'jpg');
    await writeFile(join(ws(), 'deliverables', 'report.md'), '# report');
    expect(await svc.link('t1', join(ws(), 'deliverables', 'report.md'))).toBe('report.md');
    const list = await svc.list('t1');
    expect(list.map((m) => m.name).sort()).toEqual(['photo.jpg', 'report.md']);
    const f = await svc.filePath('t1', 'report.md');
    expect(f.path).toContain(join('workspace', 'deliverables', 'report.md'));
    expect((await svc.paths('t1')).some((p) => p.endsWith(join('deliverables', 'report.md')))).toBe(true);
  });

  it('is idempotent for the same file and renames a clash with another file', async () => {
    await mkdir(join(ws(), 'deliverables', 'a'), { recursive: true });
    await writeFile(join(ws(), 'deliverables', 'x.txt'), '1');
    await writeFile(join(ws(), 'deliverables', 'a', 'x.txt'), '2');
    expect(await svc.link('t1', join(ws(), 'deliverables', 'x.txt'))).toBe('x.txt');
    expect(await svc.link('t1', join(ws(), 'deliverables', 'x.txt'))).toBe('x.txt');
    expect(await svc.link('t1', join(ws(), 'deliverables', 'a', 'x.txt'))).toBe('x-1.txt');
    expect((await svc.list('t1')).map((m) => m.name).sort()).toEqual(['x-1.txt', 'x.txt']);
  });

  it('shows the current content size and drops the entry when the source is deleted', async () => {
    const src = join(ws(), 'deliverables', 'r.md');
    await writeFile(src, '12');
    await svc.link('t1', src);
    expect((await svc.list('t1'))[0]?.size).toBe(2);
    await writeFile(src, '12345');
    expect((await svc.list('t1'))[0]?.size).toBe(5);
    await rm(src);
    expect(await svc.list('t1')).toEqual([]);
    await expect(svc.filePath('t1', 'r.md')).rejects.toThrow(/not found/);
  });

  it('refuses files outside the workspace / library, folders, relative paths and symlinks out', async () => {
    await writeFile(join(base, 'secret.txt'), 'x');
    await expect(svc.link('t1', join(base, 'secret.txt'))).rejects.toThrow(/cannot be attached/);
    await expect(svc.link('t1', join(ws(), 'deliverables'))).rejects.toThrow(/cannot be attached/);
    await expect(svc.link('t1', 'deliverables/x')).rejects.toThrow(/full path/);
    await symlink(join(base, 'secret.txt'), join(ws(), 'deliverables', 'sneaky.txt'));
    await expect(svc.link('t1', join(ws(), 'deliverables', 'sneaky.txt'))).rejects.toThrow(/cannot be attached/);
  });

  it('a link made earlier stops working if its target is later swapped for a symlink out', async () => {
    const src = join(ws(), 'deliverables', 'r.md');
    await writeFile(src, 'ok');
    await svc.link('t1', src);
    await writeFile(join(base, 'secret.txt'), 'secret');
    await rm(src);
    await symlink(join(base, 'secret.txt'), src);
    expect(await svc.list('t1')).toEqual([]);
    await expect(svc.filePath('t1', 'r.md')).rejects.toThrow(/not found/);
  });

  it('links to the library are allowed; deleting the task keeps the source', async () => {
    const lib = join(base, 'agent', 'resources', 'plan.pdf');
    await writeFile(lib, 'pdf');
    expect(await svc.link('t1', lib)).toBe('plan.pdf');
    await svc.remove('t1');
    expect(await svc.list('t1')).toEqual([]);
    await expect(svc.link('t2', lib)).resolves.toBe('plan.pdf');
  });

  it('concurrent links get distinct names', async () => {
    await writeFile(join(ws(), 'deliverables', 'a.txt'), '1');
    await mkdir(join(ws(), 'deliverables', 'd'));
    await writeFile(join(ws(), 'deliverables', 'd', 'a.txt'), '2');
    const names = await Promise.all([svc.link('t1', join(ws(), 'deliverables', 'a.txt')), svc.link('t1', join(ws(), 'deliverables', 'd', 'a.txt'))]);
    expect(new Set(names).size).toBe(2);
  });
});

describe('dot names', () => {
  it('sanitize drops leading dots so a user file can never be .links.json', async () => {
    const { sanitize } = await import('./attachments.service');
    expect(sanitize('.links.json')).toBe('links.json');
    expect(sanitize('..')).toBe('file');
    expect(sanitize('.hidden.txt')).toBe('hidden.txt');
    expect(sanitize('кухня 2.jpg')).toBe('кухня 2.jpg');
  });
  it('filePath refuses a dotted name and the links map survives', async () => {
    await writeFile(join(ws(), 'deliverables', 'r.md'), 'x');
    await svc.link('t1', join(ws(), 'deliverables', 'r.md'));
    await expect(svc.filePath('t1', '.links.json')).rejects.toThrow();
    expect((await svc.list('t1')).map((m) => m.name)).toEqual(['r.md']);
  });
});
