import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import type { ImageOptimizer } from '../media/image-optimizer.service';
import { ResourcesService } from './resources.service';

let base: string;
let svc: ResourcesService;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'res-'));
  svc = new ResourcesService({ agentDir: join(base, 'agent') } as AppConfigService, { optimize: async (path: string) => ({ path, changed: false, size: 0 }) } as unknown as ImageOptimizer);
});
afterEach(() => rm(base, { recursive: true, force: true }));

const body = (s: string | Buffer) => Readable.from([Buffer.isBuffer(s) ? s : Buffer.from(s)]);
const files = () => readdir(join(base, 'agent', 'resources', 'files'));

describe('resources upload', () => {
  it('stores the file under a safe name, keeps the original name and the type', async () => {
    const r = await svc.upload('Кухня план.PDF', body('%PDF'), {});
    expect(r).toMatchObject({ kind: 'pdf', mime: 'application/pdf', originalName: 'Кухня план.PDF', size: 4, title: 'Кухня план' });
    expect(r.file).toBe(`${r.id}-кухня-план.pdf`);
    expect(await readFile(svc.pathOf(r), 'utf8')).toBe('%PDF');
    expect(await files()).toEqual([r.file]);
  });

  it('a path in the name is reduced to its base name', async () => {
    const r = await svc.upload('../../etc/passwd.txt', body('x'), {});
    expect(r.file).toBe(`${r.id}-passwd.txt`);
    expect(r.originalName).toBe('passwd.txt');
  });

  it('refuses a declared size over the limit before reading, and a stream over the limit while reading — leaving no file', async () => {
    await expect(svc.upload('big.pdf', body('x'), {}, 26 * 1024 * 1024)).rejects.toThrow(/exceeds 25 MB/);
    const chunks = Array.from({ length: 26 }, () => Buffer.alloc(1024 * 1024));
    await expect(svc.upload('big.pdf', Readable.from(chunks), {})).rejects.toThrow(/exceeds 25 MB/);
    expect(await files().catch(() => [])).toEqual([]);
    expect((await svc.list()).length).toBe(0);
  });

  it('a video has the larger limit, by extension in any case', async () => {
    await expect(svc.upload('walk.MP4', body('x'), {}, 26 * 1024 * 1024)).resolves.toMatchObject({ kind: 'video', mime: 'video/mp4' });
    await expect(svc.upload('walk.mp4', body('x'), {}, 301 * 1024 * 1024)).rejects.toThrow(/exceeds 300 MB/);
  });

  it('refuses an empty file and a broken upload, leaving nothing', async () => {
    await expect(svc.upload('e.txt', Readable.from([]), {})).rejects.toThrow(/empty/);
    const bad = new Readable({ read() { this.destroy(new Error('connection lost')); } });
    await expect(svc.upload('x.txt', bad, {})).rejects.toThrow(/connection lost/);
    expect(await files().catch(() => [])).toEqual([]);
  });

  it('text notes are served as text, html downloads', async () => {
    const n = await svc.createNote({ title: 'Note', text: '# hi' });
    expect(n).toMatchObject({ kind: 'text', mime: 'text/markdown' });
    expect(await svc.text(n.id)).toBe('# hi');
    const h = await svc.upload('page.HTML', body('<script>'), {});
    expect(h.kind).toBe('file');
  });
});
