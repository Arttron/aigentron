import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks.service';

/** What `where` the task list asks the database for, under different filters. */
async function listWhere(params: Parameters<TasksService['list']>[0]) {
  const findMany = vi.fn(async () => []);
  const svc = Object.create(TasksService.prototype) as TasksService;
  Object.assign(svc, {
    config: { storageDriver: 'postgres' },
    projects: { get: async (slug: string) => (slug === 'shop' ? { id: 'p-shop' } : null) },
    chatAgentNames: async () => [],
    prisma: {
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
      task: { findMany, count: async () => 0, groupBy: async () => [] },
    },
  });
  await svc.list({ sort: 'created', ...params });
  return (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
}

describe('the task list asks for top-level tasks', () => {
  it('no filter: top-level only', async () => {
    expect(await listWhere({})).toEqual({ AND: [{ parentId: null }] });
  });
  it('a status filter keeps it to top-level tasks: their own status, or a subtask that has it (never the subtask itself)', async () => {
    const w = await listWhere({ status: 'blocked' });
    expect(w).toMatchObject({ AND: [{ parentId: null }, { OR: [{ status: { in: ['blocked'] } }, { subtasks: { some: { status: { in: ['blocked'] } } } }] }] });
  });
  it('a type filter or a search still looks at every level, flat', async () => {
    expect(await listWhere({ type: 'subtask' })).not.toHaveProperty('AND.0.parentId', null);
    const w = await listWhere({ q: 'login', status: 'done' });
    expect(JSON.stringify(w)).not.toContain('"parentId":null');
    expect(JSON.stringify(w)).toContain('"status":{"in":["done"');
  });
  it('the project narrows whichever shape was chosen; an unknown project lists nothing', async () => {
    const w = await listWhere({ status: 'done', project: 'shop' });
    expect(w).toMatchObject({ AND: [{ AND: [{ parentId: null }, expect.anything()] }, { projectId: 'p-shop' }] });
    expect(await listWhere({ project: 'nope' })).toMatchObject({ AND: [expect.anything(), { projectId: '' }] });
  });
});

describe('the numbers on the chips follow the list', () => {
  async function counts(type?: string, project?: string) {
    const count = vi.fn(async () => 1);
    const groupBy = vi.fn(async () => []);
    const svc = Object.create(TasksService.prototype) as TasksService;
    Object.assign(svc, {
      config: { storageDriver: 'postgres' },
      projects: { get: async (slug: string) => (slug === 'shop' ? { id: 'p-shop' } : null) },
      chatAgentNames: async () => [],
      prisma: { task: { count, groupBy } },
    });
    const out = await svc.statusCounts(type, project);
    return { out, count, groupBy };
  }
  it('without a type: top-level tasks (own status or a subtask with it), inside the project', async () => {
    const { out, count } = await counts(undefined, 'shop');
    expect(Object.keys(out)).toContain('blocked');
    const where = count.mock.calls[0]![0] as unknown as { where: { AND: unknown[] } };
    expect(JSON.stringify(where)).toContain('"parentId":null');
    expect(JSON.stringify(where)).toContain('"subtasks":{"some"');
    expect(JSON.stringify(where)).toContain('"projectId":"p-shop"');
  });
  it('with a type: flat by status, inside the project', async () => {
    const { groupBy } = await counts('subtask', 'shop');
    expect(JSON.stringify(groupBy.mock.calls[0])).toContain('p-shop');
  });
});


describe('the list puts the tasks being worked on first', () => {
  /** nActive of `total` top-level tasks are being worked on; what windows of the database does one page read? */
  async function windows(nActive: number, total: number, page: number, pageSize: number, params: Parameters<TasksService['list']>[0] = {}) {
    // a window returns as many rows as it was asked for (the database has enough of them)
    const findMany = vi.fn(async (a: { take: number }) => Array.from({ length: a.take }, (_, i) => ({ id: `t${i}` })));
    // the count of the active window names the live statuses; the total does not
    const count = vi.fn(async (a: { where: unknown }) => (JSON.stringify(a.where).includes('needs_approval') ? nActive : total));
    const svc = Object.create(TasksService.prototype) as TasksService;
    Object.assign(svc, {
      config: { storageDriver: 'postgres' },
      projects: { get: async () => null },
      chatAgentNames: async () => [],
      prisma: { $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops), task: { findMany, count, groupBy: async () => [] } },
    });
    await svc.list({ page, pageSize, ...params });
    return findMany.mock.calls.map((c) => {
      const a = c as unknown as [{ where: unknown; skip: number; take: number; orderBy: unknown }];
      return { part: JSON.stringify(a[0].where).includes('"NOT"') ? 'rest' : 'active', skip: a[0].skip, take: a[0].take, orderBy: a[0].orderBy };
    });
  }
  const newest = { createdAt: 'desc' };

  it('the first page: the active ones, then the others to fill it', async () => {
    expect(await windows(3, 7, 1, 5)).toEqual([
      { part: 'active', skip: 0, take: 3, orderBy: newest },
      { part: 'rest', skip: 0, take: 2, orderBy: newest },
    ]);
  });
  it('the next page continues the others where the first one stopped (no gap, no repeat)', async () => {
    expect(await windows(3, 7, 2, 5)).toEqual([{ part: 'rest', skip: 2, take: 5, orderBy: newest }]);
  });
  it('more active ones than a page: the page is all active; the others start after the last active page', async () => {
    expect(await windows(12, 20, 1, 5)).toEqual([{ part: 'active', skip: 0, take: 5, orderBy: newest }]);
    expect(await windows(12, 20, 3, 5)).toEqual([
      { part: 'active', skip: 10, take: 2, orderBy: newest },
      { part: 'rest', skip: 0, take: 3, orderBy: newest },
    ]);
  });
  it('nothing active: just the others, as before', async () => {
    expect(await windows(0, 4, 1, 25)).toEqual([{ part: 'rest', skip: 0, take: 25, orderBy: newest }]); // (the page size is asked for; there are only 4)
  });
  it('`sort: created` is the old order: newest first, state ignored', async () => {
    const w = await windows(3, 7, 1, 25, { sort: 'created' });
    expect(w).toEqual([{ part: 'active', skip: 0, take: 25, orderBy: newest }]); // one plain window (no NOT clause)
  });
});
