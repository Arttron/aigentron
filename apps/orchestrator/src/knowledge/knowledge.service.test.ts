import { describe, expect, it } from 'vitest';
import { KnowledgeService } from './knowledge.service';

const PROJECTS = [{ id: 'pa', slug: 'alpha', name: 'Alpha' }, { id: 'pb', slug: 'beta', name: 'Beta' }];
const base = (name: string, agents: string[], project: string | null = null) => {
  const p = project ? PROJECTS.find((x) => x.id === project)! : null;
  return { id: `id-${name}`, name, description: '', agents, chunking: {}, embedProvider: null, embedModel: null, embedDim: null, agentWrite: false, projectId: project, project: p ? { slug: p.slug, name: p.name } : null, createdAt: new Date() };
};

function service(bases: ReturnType<typeof base>[]) {
  const prisma = {
    knowledgeBase: {
      findMany: async ({ where }: { where?: { projectId?: string | null } } = {}) => (where && 'projectId' in where ? bases.filter((b) => b.projectId === where.projectId) : bases),
      findFirst: async ({ where }: { where: { OR: { name?: string; id?: string }[] } }) => bases.find((b) => where.OR.some((c) => c.name === b.name || c.id === b.id)) ?? null,
      findUnique: async ({ where }: { where: { name?: string; id?: string } }) => bases.find((b) => b.name === where.name || b.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...base(String(data.name), [], (data.projectId as string | null) ?? null), ...data } as ReturnType<typeof base>;
        bases.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = bases.find((b) => b.id === where.id)!;
        Object.assign(row, data);
        if ('projectId' in data) row.project = data.projectId ? { slug: PROJECTS.find((p) => p.id === data.projectId)!.slug, name: 'x' } : null;
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => bases.splice(bases.findIndex((b) => b.id === where.id), 1)[0],
    },
    knowledgeDoc: { count: async () => 1, findUnique: async () => null },
    knowledgeChunk: { count: async () => 3 },
    project: { findUnique: async ({ where }: { where: { slug: string } }) => PROJECTS.find((p) => p.slug === where.slug) ?? null },
  };
  return new KnowledgeService(prisma as never, {} as never, {} as never, {} as never);
}

describe('who sees which base', () => {
  const s = service([base('public', []), base('private', ['pm'])]);
  it('a named agent sees the open bases and those that list it', async () => {
    expect(await s.listReport('pm')).toContain('private');
    expect(await s.listReport('pm')).toContain('public');
    const other = await s.listReport('dev');
    expect(other).toContain('public');
    expect(other).not.toContain('private');
  });
  it('an agent that cannot be identified sees only the open bases', async () => {
    const anon = await s.listReport(null);
    expect(anon).toContain('public');
    expect(anon).not.toContain('private');
    expect(await s.promptBlock(null)).not.toContain('private');
  });
  it('a document of a hidden base cannot be read by id', async () => {
    const prisma = {
      knowledgeBase: { findMany: async () => [base('private', ['pm'])] },
      knowledgeDoc: { findUnique: async () => ({ id: 'd1', kbId: 'id-private', title: 't', source: null, kb: {} }) },
      knowledgeChunk: { findMany: async () => [{ idx: 0, heading: '', text: 'secret' }] },
    };
    const svc = new KnowledgeService(prisma as never, {} as never, {} as never, {} as never);
    expect(await svc.readReport({ doc: 'd1', chunk: 0 }, 'dev')).toBe('No such document. Use kb_search to find ids.');
    expect(await svc.readReport({ doc: 'd1', chunk: 0 }, 'pm')).toContain('secret');
    expect(await svc.readReport({ doc: 'd1', chunk: 0 }, null)).toBe('No such document. Use kb_search to find ids.');
  });
  it('kb_add refuses a read-only base', async () => {
    expect(await s.addReport({ kb: 'public', title: 'x', text: 'y' }, 'pm')).toContain('read-only');
  });
});

describe('bases of a project', () => {
  const bases = () => [base('public', []), base('alpha-codes', [], 'pa'), base('alpha-pm', ['pm'], 'pa'), base('beta-codes', [], 'pb')];
  it('kb_list for a task shows the global bases and its project\'s, with a scope column; another project\'s stay hidden', async () => {
    const s = service(bases());
    const a = await s.listReport('pm', { projectId: 'pa' });
    expect(a).toContain('name | scope |');
    expect(a).toContain('public | global |');
    expect(a).toContain('alpha-codes | project "Alpha" |');
    expect(a).toContain('alpha-pm | project "Alpha" |');
    expect(a).not.toContain('beta-codes');
    const dev = await s.listReport('dev', { projectId: 'pa' });
    expect(dev).not.toContain('alpha-pm'); // the agents filter stays
    const b = await s.listReport('pm', { projectId: 'pb' });
    expect(b).toContain('beta-codes');
    expect(b).not.toContain('alpha');
    expect(await s.listReport('pm', { projectId: 'none' })).not.toContain('project');
    expect(await s.listReport('pm')).toContain('beta-codes'); // no scope = everything (the dashboard)
  });
  it('the prompt block, kb_read and kb_add follow the same scope', async () => {
    const s = service(bases());
    const block = await s.promptBlock('pm', { projectId: 'pa' });
    expect(block).toContain('alpha-codes (project alpha)');
    expect(block).not.toContain('beta-codes');
    expect(await s.addReport({ kb: 'beta-codes', title: 'x', text: 'y' }, 'pm', { projectId: 'pa' })).toContain('There is no knowledge base "beta-codes" for you');
    expect(await s.addReport({ kb: 'alpha-codes', title: 'x', text: 'y' }, 'pm', { projectId: 'pa' })).toContain('read-only');
  });
  it('a document of another project\'s base cannot be read by id from a task', async () => {
    const list = bases();
    const prisma = {
      knowledgeBase: { findMany: async () => list },
      knowledgeDoc: { findUnique: async () => ({ id: 'd1', kbId: 'id-beta-codes', title: 't', source: null, kb: {} }) },
      knowledgeChunk: { findMany: async () => [{ idx: 0, heading: '', text: 'beta secret' }] },
    };
    const svc = new KnowledgeService(prisma as never, {} as never, {} as never, {} as never);
    expect(await svc.readReport({ doc: 'd1', chunk: 0 }, 'pm', { projectId: 'pa' })).toBe('No such document. Use kb_search to find ids.');
    expect(await svc.readReport({ doc: 'd1', chunk: 0 }, 'pm', { projectId: 'pb' })).toContain('beta secret');
    expect(await svc.readReport({ doc: 'd1', chunk: 0 }, 'pm')).toContain('beta secret'); // the dashboard / no scope
  });
  it('the API: list by scope, create with a project, move with PATCH {project}, an unknown project is a 404', async () => {
    const s = service(bases());
    expect((await s.list()).map((k) => [k.name, k.project])).toEqual([['public', null], ['alpha-codes', 'alpha'], ['alpha-pm', 'alpha'], ['beta-codes', 'beta']]);
    expect((await s.list('global')).map((k) => k.name)).toEqual(['public']);
    expect((await s.list('alpha')).map((k) => k.name)).toEqual(['alpha-codes', 'alpha-pm']);
    await expect(s.list('nope')).rejects.toThrow(/not found/);
    const made = await s.create({ name: 'beta-new', project: 'beta' });
    expect(made.project).toBe('beta');
    expect((await s.create({ name: 'global-new', project: 'global' })).project).toBeNull();
    await expect(s.create({ name: 'x', project: 'nope' })).rejects.toThrow(/not found/);
    expect((await s.update('beta-new', { project: 'alpha' })).project).toBe('alpha');
    expect((await s.update('beta-new', { project: null })).project).toBeNull();
    expect(await s.releaseProject('pa', 'delete')).toEqual({ released: 0, deleted: 2 });
    expect((await s.list('alpha')).length).toBe(0);
    expect(await s.releaseProject('pb', 'keep')).toEqual({ released: 1, deleted: 0 });
    expect((await s.list('beta')).length).toBe(1); // keep leaves them to the database's SET NULL
  });
});
