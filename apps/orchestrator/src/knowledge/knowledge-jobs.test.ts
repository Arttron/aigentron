import { describe, expect, it } from 'vitest';
import { KnowledgeService } from './knowledge.service';

/** A fake database: one base, documents and chunks kept in arrays (enough for the background-import flow). */
function service() {
  const kb = { id: 'kb1', name: 'codes', description: '', agents: [], chunking: {}, embedProvider: null, embedModel: null, embedDim: null, agentWrite: false, createdAt: new Date() };
  const docs: { id: string; kbId: string; title: string; source: string | null; kind: string; hash: string; size: number; createdAt: Date; chunks: number }[] = [];
  const prisma = {
    knowledgeBase: { findMany: async () => [kb], findFirst: async () => kb, findUnique: async () => kb },
    knowledgeDoc: {
      findUnique: async ({ where }: { where: { id?: string; kbId_hash?: { hash: string } } }) => docs.find((d) => (where.id ? d.id === where.id : d.hash === where.kbId_hash!.hash)) ?? null,
      findMany: async () => docs.map((d) => ({ ...d, _count: { chunks: d.chunks } })),
      create: async ({ data }: { data: { id?: string; kbId: string; title: string; source: string | null; kind: string; hash: string; size: number; chunks: { create: unknown[] } } }) => {
        const row = { id: data.id ?? `auto${docs.length}`, kbId: data.kbId, title: data.title, source: data.source, kind: data.kind, hash: data.hash, size: data.size, createdAt: new Date(), chunks: data.chunks.create.length };
        docs.push(row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => docs.splice(docs.findIndex((d) => d.id === where.id), 1),
      count: async () => docs.length,
    },
    knowledgeChunk: { count: async () => docs.reduce((a, d) => a + d.chunks, 0) },
  };
  const resources = {
    get: async (id: string) => ({ id, title: 'Note', kind: 'text', originalName: 'n.md', size: 2, file: 'x' }),
    pathOf: () => '/nope/does-not-exist.md',
  };
  return { svc: new KnowledgeService(prisma as never, {} as never, {} as never, resources as never), docs };
}

describe('documents added in the background (202)', () => {
  it('a note is accepted at once as processing, then listed as ready with its passages, under the id that was promised', async () => {
    const { svc } = service();
    const a = await svc.addNote('codes', { title: 'Rules', text: '# Rules\n\nAlways measure twice.' });
    expect(a).toMatchObject({ status: 'processing', docId: a.id, chunks: 0, duplicate: false });
    expect(await svc.listDocs('codes')).toEqual([expect.objectContaining({ id: a.id, title: 'Rules', status: 'processing', chunks: 0 })]);
    await svc.idle();
    const list = await svc.listDocs('codes');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a.id, title: 'Rules', status: 'ready' });
    expect(list[0]!.chunks).toBeGreaterThan(0);
  });

  it('a file that cannot be read ends as error with the reason, stays listed, and can be dismissed', async () => {
    const { svc, docs } = service();
    const a = await svc.addFile('codes', 'scan.pdf', Buffer.from('not a pdf'), 'Scan');
    await svc.idle();
    const list = await svc.listDocs('codes');
    expect(list[0]).toMatchObject({ id: a.id, title: 'Scan', kind: 'file', status: 'error' });
    expect(list[0]!.error).toBeTruthy();
    expect(docs).toHaveLength(0);
    await svc.removeDoc(a.id);
    expect(await svc.listDocs('codes')).toEqual([]);
  });

  it('the same text twice: the second import reports a duplicate instead of a second document', async () => {
    const { svc, docs } = service();
    await svc.addNote('codes', { title: 'A', text: 'Same text here, long enough to index.' });
    const b = await svc.addNote('codes', { title: 'B', text: 'Same text here, long enough to index.' });
    await svc.idle();
    expect(docs).toHaveLength(1);
    expect((await svc.listDocs('codes')).find((d) => d.id === b.id)).toMatchObject({ status: 'error', error: expect.stringMatching(/already in the base/) });
  });

  it('a missing resource file is an error of the job, not of the request; an unknown base is refused at once', async () => {
    const { svc } = service();
    const a = await svc.importResource('codes', 'r1');
    expect(a.status).toBe('processing');
    await svc.idle();
    expect((await svc.listDocs('codes'))[0]).toMatchObject({ id: a.id, kind: 'resource', status: 'error', error: expect.stringMatching(/missing/) });
    await expect(svc.addNote('codes', { text: '  ' })).rejects.toThrow(/empty/);
    await expect(svc.addFile('codes', 'x.txt', Buffer.alloc(21 * 1024 * 1024))).rejects.toThrow(/too large/);
  });
});
