import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import type { ImageOptimizer } from '../media/image-optimizer.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourcesService } from './resources.service';

/** Three projects on disk: the default one (its library is `<WORKSPACE_DIR>/library`), `alpha` and `beta` under PROJECTS_DIR; `old` is archived. */
const PROJECTS = [
  { id: 'proj_default', slug: 'default', isDefault: true },
  { id: 'pa', slug: 'alpha', isDefault: false },
  { id: 'pb', slug: 'beta', isDefault: false },
  { id: 'po', slug: 'old', isDefault: false },
];
const fakePrisma = {
  project: {
    findUnique: async ({ where }: { where: { slug: string } }) => PROJECTS.find((p) => p.slug === where.slug) ?? null,
    findMany: async () => PROJECTS,
  },
} as unknown as PrismaService;

let base: string;
let svc: ResourcesService;
let cfg: { agentDir: string; workspaceDir: string; projectsDir: string };
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'res-'));
  cfg = { agentDir: join(base, 'agent'), workspaceDir: join(base, 'workspace'), projectsDir: join(base, 'projects') };
  svc = new ResourcesService(cfg as AppConfigService, { optimize: async (path: string) => ({ path, changed: false, size: 0 }) } as unknown as ImageOptimizer, fakePrisma);
});
afterEach(() => rm(base, { recursive: true, force: true }));

const body = (s: string | Buffer) => Readable.from([Buffer.isBuffer(s) ? s : Buffer.from(s)]);
const files = (dir = join(base, 'agent', 'resources', 'files')) => readdir(dir);
const exists = (p: string) => stat(p).then(() => true, () => false);

describe('resources upload (the global library, as before)', () => {
  it('stores the file under a safe name, keeps the original name and the type; the item is global', async () => {
    const r = await svc.upload('Кухня план.PDF', body('%PDF'), {});
    expect(r).toMatchObject({ kind: 'pdf', mime: 'application/pdf', originalName: 'Кухня план.PDF', size: 4, title: 'Кухня план', project: null });
    expect(r.file).toBe(`${r.id}-кухня-план.pdf`);
    expect(await readFile(await svc.pathOf(r), 'utf8')).toBe('%PDF');
    expect(await files()).toEqual([r.file]);
    expect(await svc.pathOf(r)).toBe(join(cfg.agentDir, 'resources', 'files', r.file));
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
    expect(n).toMatchObject({ kind: 'text', mime: 'text/markdown', project: null });
    expect(await svc.text(n.id)).toBe('# hi');
    const h = await svc.upload('page.HTML', body('<script>'), {});
    expect(h.kind).toBe('file');
  });
});

describe('project libraries', () => {
  it('a project item lives in <project dir>/library, the default project\'s in <WORKSPACE_DIR>/library; an unknown project is a 404', async () => {
    const a = await svc.createNote({ title: 'Alpha brief', text: 'a', project: 'alpha' });
    expect(a.project).toBe('alpha');
    expect(await svc.pathOf(a)).toBe(join(cfg.projectsDir, 'alpha', 'library', 'files', a.file));
    const d = await svc.upload('plan.pdf', body('%PDF'), { project: 'default' });
    expect(d.project).toBe('default');
    expect(await svc.pathOf(d)).toBe(join(cfg.workspaceDir, 'library', 'files', d.file));
    expect(await exists(join(cfg.agentDir, 'resources', 'index.json'))).toBe(false); // nothing landed in the global one
    await expect(svc.createNote({ title: 'x', text: 'x', project: 'nope' })).rejects.toThrow(/not found/);
    // `global` and '' mean the global library
    expect((await svc.createNote({ title: 'g', text: 'g', project: 'global' })).project).toBeNull();
    expect((await svc.createNote({ title: 'g2', text: 'g', project: '' })).project).toBeNull();
  });

  it('list: all / global / one project; each library has its own usage', async () => {
    await svc.createNote({ title: 'G', text: 'g' });
    await svc.createNote({ title: 'A', text: 'a', project: 'alpha' });
    await svc.createNote({ title: 'B', text: 'bb', project: 'beta' });
    expect((await svc.list()).map((r) => [r.title, r.project]).sort()).toEqual([['A', 'alpha'], ['B', 'beta'], ['G', null]]);
    expect((await svc.list('global')).map((r) => r.title)).toEqual(['G']);
    expect((await svc.list('alpha')).map((r) => r.title)).toEqual(['A']);
    expect((await svc.list('old')).map((r) => r.title)).toEqual([]);
    await expect(svc.list('nope')).rejects.toThrow(/not found/);
    expect(await svc.usage('beta')).toMatchObject({ count: 1, bytes: 2 });
    expect(await svc.usage('global')).toMatchObject({ count: 1, bytes: 1 });
    expect(await svc.usage('all')).toMatchObject({ count: 1, bytes: 1 }); // = the global library's, as before
  });

  it('get / text / update / remove find an item by id in whichever library holds it', async () => {
    const a = await svc.createNote({ title: 'A', text: 'alpha text', project: 'alpha' });
    expect((await svc.get(a.id)).project).toBe('alpha');
    expect(await svc.text(a.id)).toBe('alpha text');
    const u = await svc.update(a.id, { description: 'd', text: 'new' });
    expect(u).toMatchObject({ project: 'alpha', description: 'd', size: 3 });
    expect(await readFile(await svc.pathOf(u), 'utf8')).toBe('new');
    await svc.remove(a.id);
    await expect(svc.get(a.id)).rejects.toThrow(/not found/);
    expect(await files(join(cfg.projectsDir, 'alpha', 'library', 'files'))).toEqual([]);
  });

  it('PUT {project} moves an item between libraries (file and entry), keeping its id', async () => {
    const a = await svc.createNote({ title: 'Moving', text: 'm', project: 'alpha', tags: ['t'] });
    const g = await svc.update(a.id, { project: null });
    expect(g).toMatchObject({ id: a.id, project: null, title: 'Moving', tags: ['t'] });
    expect(await exists(join(cfg.agentDir, 'resources', 'files', g.file))).toBe(true);
    expect(await exists(join(cfg.projectsDir, 'alpha', 'library', 'files', a.file))).toBe(false);
    expect((await svc.list('alpha')).length).toBe(0);
    const b = await svc.update(a.id, { project: 'beta', title: 'Moved again' });
    expect(b).toMatchObject({ id: a.id, project: 'beta', title: 'Moved again' });
    expect(await svc.text(a.id)).toBe('m');
    expect((await svc.list('global')).length).toBe(0);
    expect((await svc.update(a.id, { project: 'beta' })).project).toBe('beta'); // no-op move
  });
});

describe('what a task sees (prompt index and resources_search)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 2)); // distinct updatedAt
  it('the task\'s project library comes FIRST, then the global one; another project\'s items never show; the agents filter still applies', async () => {
    const g1 = await svc.createNote({ title: 'Global one', text: 'g', description: 'shared' });
    await tick();
    const b = await svc.createNote({ title: 'Beta secret', text: 'b', project: 'beta' });
    await tick();
    const a1 = await svc.createNote({ title: 'Alpha one', text: 'a', project: 'alpha' });
    await tick();
    const g2 = await svc.createNote({ title: 'Global two', text: 'g', agents: ['designer'] });
    const index = await svc.promptIndex('tutor', 'alpha');
    const lines = index.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.map((l) => l.slice(2).split(' — ')[0]!.split(' (')[0])).toEqual(['Alpha one', 'Global one']);
    expect(index).toContain(`(text, project) → ${await svc.pathOf(a1)}`);
    expect(index).toContain(`(text) → ${await svc.pathOf(g1)}`);
    expect(index).not.toContain('Beta secret');
    expect(index).not.toContain('Global two'); // meant for the designer only
    expect(await svc.promptIndex('designer', 'alpha')).toContain('Global two');
    // the designer of beta: beta's item first, then the global ones (newest first within the global group)
    const beta = (await svc.promptIndex('designer', 'beta')).split('\n').filter((l) => l.startsWith('- '));
    expect(beta.map((l) => l.slice(2).split(' (')[0]!.split(' — ')[0])).toEqual(['Beta secret', 'Global two', 'Global one']);
    expect(b.project).toBe('beta');
    expect(g2.project).toBeNull();
  });

  it('a task of the default project sees <WORKSPACE_DIR>/library + global; no project (or an unknown one) = global only', async () => {
    await svc.createNote({ title: 'Default note', text: 'd', project: 'default' });
    await svc.createNote({ title: 'Alpha note', text: 'a', project: 'alpha' });
    await svc.createNote({ title: 'Global note', text: 'g' });
    const d = await svc.promptIndex(undefined, 'default');
    expect(d).toContain('Default note');
    expect(d).toContain('Global note');
    expect(d).not.toContain('Alpha note');
    const none = await svc.promptIndex(undefined, null);
    expect(none).toContain('Global note');
    expect(none).not.toContain('Default note');
    expect(await svc.promptIndex(undefined, 'ghost')).toBe(none);
    expect(await svc.promptIndex(undefined, 'old')).toBe(none); // an archived project's tasks still see the global library
  });

  it('the shared cap counts both libraries; the overflow note points to the tool', async () => {
    for (let i = 0; i < 20; i++) await svc.createNote({ title: `G${i}`, text: 'g' });
    for (let i = 0; i < 10; i++) await svc.createNote({ title: `A${i}`, text: 'a', project: 'alpha' });
    const index = await svc.promptIndex(undefined, 'alpha');
    const lines = index.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(25);
    expect(lines.slice(0, 10).every((l) => /^- A\d/.test(l))).toBe(true);
    expect(index).toContain('+5 more');
  });

  it('resources_search covers the task\'s project and the global library, never another project\'s; the scope column names the project', async () => {
    await svc.createNote({ title: 'Kitchen plan', text: 'g', description: 'global plan' });
    await svc.createNote({ title: 'Kitchen alpha', text: 'a', project: 'alpha' });
    await svc.createNote({ title: 'Kitchen beta', text: 'b', project: 'beta' });
    const r = await svc.searchReport({ query: 'kitchen' }, 'tutor', 'alpha');
    expect(r).toContain('2 match(es)');
    expect(r).toContain('Kitchen alpha | text | alpha |');
    expect(r).toContain('Kitchen plan | text | global |');
    expect(r).not.toContain('Kitchen beta');
    expect(r.indexOf('Kitchen alpha')).toBeLessThan(r.indexOf('Kitchen plan')); // the project's own first on an equal score
    expect(await svc.searchReport({ query: 'kitchen' }, 'tutor', null)).toContain('1 match(es)');
    expect(await svc.searchReport({ query: 'kitchen' }, 'tutor', 'beta')).toContain('Kitchen beta');
  });
});

describe('a project is deleted', () => {
  it('keep: its items move into the global library under files/<slug>/, tagged with the slug; the project folder\'s library is gone', async () => {
    const a = await svc.createNote({ title: 'Alpha brief', text: 'brief', project: 'alpha', tags: ['brief'] });
    await svc.createNote({ title: 'Beta brief', text: 'b', project: 'beta' });
    expect(await svc.countOf({ slug: 'alpha', isDefault: false })).toBe(1);
    expect(await svc.releaseProject({ slug: 'alpha', isDefault: false }, 'keep')).toEqual({ moved: 1, deleted: 0 });
    const kept = await svc.get(a.id);
    expect(kept).toMatchObject({ project: null, title: 'Alpha brief', tags: ['brief', 'alpha'], file: join('alpha', a.file) });
    expect(await svc.pathOf(kept)).toBe(join(cfg.agentDir, 'resources', 'files', 'alpha', a.file));
    expect(await readFile(await svc.pathOf(kept), 'utf8')).toBe('brief');
    expect(await exists(join(cfg.projectsDir, 'alpha', 'library'))).toBe(false);
    expect((await svc.list('beta')).length).toBe(1);
    expect(await svc.countOf({ slug: 'alpha', isDefault: false })).toBe(0);
    // the moved item behaves like any global one afterwards
    expect(await svc.text(a.id)).toBe('brief');
    await svc.remove(a.id);
    expect(await exists(join(cfg.agentDir, 'resources', 'files', 'alpha', a.file))).toBe(false);
  });

  it('delete: the library and its files are removed; the default project is refused; an empty library is fine', async () => {
    const a = await svc.createNote({ title: 'Alpha brief', text: 'brief', project: 'alpha' });
    expect(await svc.releaseProject({ slug: 'alpha', isDefault: false }, 'delete')).toEqual({ moved: 0, deleted: 1 });
    await expect(svc.get(a.id)).rejects.toThrow(/not found/);
    expect(await exists(join(cfg.projectsDir, 'alpha', 'library'))).toBe(false);
    expect((await svc.list('global')).length).toBe(0);
    await expect(svc.releaseProject({ slug: 'default', isDefault: true }, 'keep')).rejects.toThrow(/default project/);
    expect(await svc.releaseProject({ slug: 'beta', isDefault: false }, 'keep')).toEqual({ moved: 0, deleted: 0 });
  });
});
