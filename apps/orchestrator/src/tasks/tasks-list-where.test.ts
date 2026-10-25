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
  await svc.list(params);
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
