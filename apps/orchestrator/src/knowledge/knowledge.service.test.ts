import { describe, expect, it } from 'vitest';
import { KnowledgeService } from './knowledge.service';

const base = (name: string, agents: string[]) => ({ id: `id-${name}`, name, description: '', agents, chunking: {}, embedProvider: null, embedModel: null, embedDim: null, agentWrite: false, createdAt: new Date() });

function service(bases: ReturnType<typeof base>[]) {
  const prisma = {
    knowledgeBase: { findMany: async () => bases },
    knowledgeDoc: { count: async () => 1, findUnique: async () => null },
    knowledgeChunk: { count: async () => 3 },
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
