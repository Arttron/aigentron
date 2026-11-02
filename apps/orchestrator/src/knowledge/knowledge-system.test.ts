import { describe, expect, it } from 'vitest';
import { KnowledgeService } from './knowledge.service';

/** An in-memory database just big enough for a platform-kept base. */
function make() {
  const bases: Record<string, unknown>[] = [];
  const docs: { id: string; kbId: string; title: string; hash: string; text: string }[] = [];
  let n = 0;
  const prisma = {
    knowledgeBase: {
      findUnique: async ({ where }: { where: { name?: string } }) => bases.find((b) => b.name === where.name) ?? null,
      findFirst: async ({ where }: { where: { OR: { name?: string; id?: string }[] } }) => bases.find((b) => where.OR.some((c) => c.name === b.name || c.id === b.id)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `kb${++n}`, createdAt: new Date(), embedProvider: null, embedModel: null, embedDim: null, projectId: null, project: null, ...data };
        bases.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(bases.find((b) => b.id === where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => bases.splice(bases.findIndex((b) => b.id === where.id), 1),
    },
    knowledgeDoc: {
      findMany: async ({ where }: { where: { kbId: string } }) => docs.filter((d) => d.kbId === where.kbId),
      findUnique: async ({ where }: { where: { kbId_hash?: { kbId: string; hash: string }; id?: string } }) =>
        where.kbId_hash ? (docs.find((d) => d.kbId === where.kbId_hash!.kbId && d.hash === where.kbId_hash!.hash) ?? null) : (docs.find((d) => d.id === where.id) ? { ...docs.find((d) => d.id === where.id)!, kb: bases.find((b) => b.id === docs.find((d) => d.id === where.id)!.kbId) } : null),
      create: async ({ data }: { data: { kbId: string; title: string; hash: string; chunks: { create: unknown[] } } }) => {
        const d = { id: `d${++n}`, kbId: data.kbId, title: data.title, hash: data.hash, text: '' };
        docs.push(d);
        return d;
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => void where.id.in.forEach((id) => docs.splice(docs.findIndex((d) => d.id === id), 1)),
      delete: async ({ where }: { where: { id: string } }) => void docs.splice(docs.findIndex((d) => d.id === where.id), 1),
      count: async () => docs.length,
    },
    knowledgeChunk: { count: async () => 0 },
  };
  return { svc: new KnowledgeService(prisma as never, {} as never, {} as never, {} as never), bases, docs };
}

const spec = { name: 'admin-reference', description: 'The administrator reference', agents: ['admin'] };
const d = (title: string, body = 'x') => ({ title, text: `## ${title}\n${body.repeat(80)}`, source: 'skills/core/admin/a.md' });

describe('a knowledge base kept by the platform', () => {
  it('is created read-only for the named agents and filled with the documents', async () => {
    const { svc, bases, docs } = make();
    expect(await svc.syncSystemBase(spec, [d('a: One'), d('a: Two')])).toEqual({ added: 2, removed: 0, kept: 0 });
    expect(bases[0]).toMatchObject({ name: 'admin-reference', system: true, agentWrite: false, agents: ['admin'] });
    expect(docs).toHaveLength(2);
  });
  it('a second run with the same guides changes nothing; a changed or removed section is replaced / dropped', async () => {
    const { svc, docs } = make();
    await svc.syncSystemBase(spec, [d('a: One'), d('a: Two')]);
    expect(await svc.syncSystemBase(spec, [d('a: One'), d('a: Two')])).toEqual({ added: 0, removed: 0, kept: 2 });
    expect(await svc.syncSystemBase(spec, [d('a: One'), d('a: Two', 'changed ')])).toEqual({ added: 1, removed: 1, kept: 1 });
    expect(await svc.syncSystemBase(spec, [d('a: One')])).toEqual({ added: 0, removed: 1, kept: 1 });
    expect(docs).toHaveLength(1);
    expect(await svc.documentTitles('admin-reference')).toEqual(['a: One']);
  });
  it('refuses to take over a base a person made with the same name', async () => {
    const { svc, bases } = make();
    bases.push({ id: 'mine', name: 'admin-reference', system: false, agents: [] });
    await expect(svc.syncSystemBase(spec, [d('a: One')])).rejects.toThrow(/not the platform's/);
  });
  it('cannot be changed by hand: no notes, no files, no edit, no delete, no removing a document', async () => {
    const { svc, docs } = make();
    await svc.syncSystemBase(spec, [d('a: One')]);
    await expect(svc.addNote('admin-reference', { text: 'hi there' })).rejects.toThrow(/kept by the platform/);
    await expect(svc.addFile('admin-reference', 'x.txt', Buffer.from('hello'))).rejects.toThrow(/kept by the platform/);
    await expect(svc.update('admin-reference', { description: 'x' })).rejects.toThrow(/kept by the platform/);
    await expect(svc.remove('admin-reference')).rejects.toThrow(/kept by the platform/);
    await expect(svc.removeDoc(docs[0]!.id)).rejects.toThrow(/kept by the platform/);
    await expect(svc.addDocument('admin-reference', { text: 'a note that is long enough' })).rejects.toThrow(/kept by the platform/);
  });
});

describe('syncing a base with a section that cannot be indexed', () => {
  it('skips it and still adds the others', async () => {
    const { svc, docs } = make();
    // an empty-after-trim text makes addDocument throw ("The document is empty") for that one section
    const r = await svc.syncSystemBase(spec, [d('a: One'), { title: 'a: Blank', text: '   ', source: 's' }, d('a: Two')]);
    expect(r.added).toBe(2);
    expect(docs.map((x) => x.title).sort()).toEqual(['a: One', 'a: Two']);
  });
});
