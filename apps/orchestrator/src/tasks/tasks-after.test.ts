import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks.service';

vi.mock('../discussion/discussion.service', () => ({ DiscussionService: class DiscussionService {} }));

/** Subtasks ordered with `after`: held without a job, started (or blocked) by the server when what they wait for has settled. */
interface Row { id: string; title: string; prompt: string; status: string; agentName: string | null; parentId: string | null; waitingFor: string }

function make(initial: Row[]) {
  const rows = [...initial];
  const enqueued: string[] = [];
  const statuses: string[] = [];
  const created: Array<{ row: Row; autostart: boolean | undefined; refs: string[] }> = [];
  const hasId = (w: { in?: string[] } | string | undefined, id: string) => (typeof w === 'string' ? w === id : w?.in ? w.in.includes(id) : true);
  const prisma = {
    task: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => {
          if (where.parentId !== undefined && r.parentId !== where.parentId) return false;
          if (where.id !== undefined && !hasId(where.id as never, r.id)) return false;
          if (where.status !== undefined && r.status !== where.status) return false;
          const wf = where.waitingFor as { contains?: string; not?: string } | string | undefined;
          if (typeof wf === 'string' && r.waitingFor !== wf) return false;
          if (wf && typeof wf === 'object') {
            if (wf.contains !== undefined && !r.waitingFor.includes(wf.contains)) return false;
            if (wf.not !== undefined && r.waitingFor === wf.not) return false;
          }
          return true;
        }),
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      update: async () => ({}),
      updateMany: async ({ where, data }: { where: { id: string; status: string; waitingFor: string }; data: Partial<Row> }) => {
        const r = rows.find((x) => x.id === where.id && x.status === where.status && x.waitingFor === where.waitingFor);
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
  };
  const svc = Object.create(TasksService.prototype) as TasksService & Record<string, unknown>;
  Object.assign(svc, {
    prisma,
    logger: { log: () => undefined, warn: () => undefined },
    get: async (id: string) => ({ ...(rows.find((r) => r.id === id) ?? { id }), linksOut: [], createdById: null }),
    resolveAgentName: async (n: string) => n,
    create: async (dto: { prompt: string; title?: string; autostart?: boolean; references?: string[] }, _u: unknown, o: { waitingFor?: string[] }) => {
      const row: Row = { id: `s${rows.length + 1}`, title: dto.title ?? 'new', prompt: dto.prompt, status: 'queued', agentName: null, parentId: 'P', waitingFor: JSON.stringify(o.waitingFor ?? []) };
      rows.push(row);
      created.push({ row, autostart: dto.autostart, refs: dto.references ?? [] });
      return row;
    },
    setStatus: async (id: string, s: string) => {
      statuses.push(`${id}:${s}`);
      const r = rows.find((x) => x.id === id);
      if (r) r.status = s;
    },
    enqueueRun: async (d: { taskId: string }) => void enqueued.push(d.taskId),
  });
  return { svc: svc as unknown as TasksService, rows, enqueued, statuses, created };
}

const P: Row = { id: 'P', title: 'lead', prompt: 'lead', status: 'running', agentName: 'pm', parentId: null, waitingFor: '[]' };
const sub = (o: Partial<Row>): Row => ({ id: 's0', title: 'research', prompt: 'p', status: 'running', agentName: 'x', parentId: 'P', waitingFor: '[]', ...o });
const input = { prompt: 'Build the thing from the research, step by step', title: 'build', after: ['s1'] };

describe('create_subtask with `after`', () => {
  it('holds the new subtask (no job), remembers what it waits for, and folds the predecessor into its context', async () => {
    const { svc, created, enqueued } = make([P, sub({ id: 's1' })]);
    const r = (await svc.createSubtask('P', input, undefined, { fromAgent: true })) as { waitingFor?: string[] };
    expect(r.waitingFor).toEqual(['s1']);
    expect(created[0]!.autostart).toBe(false);
    expect(created[0]!.row.waitingFor).toBe('["s1"]');
    expect(created[0]!.refs).toContain('s1');
    expect(enqueued).toEqual([]);
  });

  it('a predecessor that is already done is nothing to wait for: the subtask starts at once, with its result as context', async () => {
    const { svc, created } = make([P, sub({ id: 's1', status: 'done' })]);
    const r = (await svc.createSubtask('P', input, undefined, { fromAgent: true })) as { waitingFor?: string[] };
    expect(r.waitingFor).toEqual([]);
    expect(created[0]!.autostart).toBeUndefined();
    expect(created[0]!.refs).toContain('s1');
  });

  it('refuses an id that is not a subtask of this lead, and a predecessor that ended badly', async () => {
    const other = sub({ id: 'x9', parentId: 'OTHER' });
    await expect(make([P, other]).svc.createSubtask('P', { ...input, after: ['x9'] }, undefined, { fromAgent: true })).rejects.toThrow(/not a subtask of this task/);
    await expect(make([P, sub({ id: 's1', status: 'failed' })]).svc.createSubtask('P', input, undefined, { fromAgent: true })).rejects.toThrow(/ended failed/);
    await expect(make([P, sub({ id: 's1', status: 'cancelled' })]).svc.createSubtask('P', input, undefined, { fromAgent: true })).rejects.toThrow(/nothing to wait for/);
  });
});

describe('releasing what waited', () => {
  const held = (waits: string[]) => sub({ id: 's2', title: 'build', status: 'queued', waitingFor: JSON.stringify(waits) });

  it('starts the held subtask when its predecessor is done, once', async () => {
    const { svc, rows, enqueued } = make([P, sub({ id: 's1', status: 'done' }), held(['s1'])]);
    await svc.releaseDependents('s1');
    await svc.releaseDependents('s1'); // a second settle point for the same task
    expect(enqueued).toEqual(['s2']);
    expect(rows.find((r) => r.id === 's2')!.waitingFor).toBe('[]');
  });

  it('keeps waiting while any predecessor is still going, and starts when the last one is done', async () => {
    const { svc, rows, enqueued } = make([P, sub({ id: 's1', status: 'done' }), sub({ id: 's3', status: 'running' }), held(['s1', 's3'])]);
    await svc.releaseDependents('s1');
    expect(enqueued).toEqual([]);
    rows.find((r) => r.id === 's3')!.status = 'done';
    await svc.releaseDependents('s3');
    expect(enqueued).toEqual(['s2']);
  });

  it('blocks it (with the reason) when a predecessor ended badly, so the lead can decide', async () => {
    const { svc, statuses, enqueued } = make([P, sub({ id: 's1', status: 'failed' }), held(['s1'])]);
    await svc.releaseDependents('s1');
    expect(enqueued).toEqual([]);
    expect(statuses).toEqual(['s2:blocked']);
  });

  it('a deleted predecessor counts as cancelled: the held subtask is blocked, not left waiting for ever', async () => {
    const { svc, statuses } = make([P, held(['gone'])]);
    await svc.releaseDependents('gone');
    expect(statuses).toEqual(['s2:blocked']);
  });

  it('the sweep (after a restart) makes up a release that was missed', async () => {
    const { svc, enqueued } = make([P, sub({ id: 's1', status: 'done' }), held(['s1'])]);
    expect(await svc.releaseAllReady()).toBe(1);
    expect(enqueued).toEqual(['s2']);
    expect(await svc.releaseAllReady()).toBe(0);
  });

  it('waitingOn names what a held subtask waits for', async () => {
    const { svc } = make([P, sub({ id: 's1', title: 'research', status: 'running' }), held(['s1'])]);
    expect(await svc.waitingOn('s2')).toEqual([{ id: 's1', title: 'research', status: 'running' }]);
    expect(await svc.waitingOn('s1')).toEqual([]);
  });
});
