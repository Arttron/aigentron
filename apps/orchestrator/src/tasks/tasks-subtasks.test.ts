import { describe, expect, it } from 'vitest';
import { TasksService } from './tasks.service';

type Row = { id: string; title: string; prompt: string; status: string; agentName: string | null; parentId: string | null };

function make(rows: Row[]) {
  const statuses: string[] = [];
  const prisma = {
    task: {
      findMany: async ({ where }: { where: { parentId: string } }) => rows.filter((r) => r.parentId === where.parentId),
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      update: async () => ({}),
    },
  };
  const svc = Object.create(TasksService.prototype) as TasksService & Record<string, unknown>;
  Object.assign(svc, {
    prisma,
    logger: { log: () => undefined, warn: () => undefined },
    get: async (id: string) => ({ ...(rows.find((r) => r.id === id) ?? { id, title: '', prompt: '', status: 'queued', agentName: null }), linksOut: [], createdById: null }),
    resolveAgentName: async (n: string) => n,
    create: async (dto: { prompt: string; title?: string }) => {
      const row: Row = { id: `s${rows.length + 1}`, title: dto.title ?? 'new', prompt: dto.prompt, status: 'queued', agentName: null, parentId: 'P' };
      rows.push(row);
      return row;
    },
    setStatus: async (id: string, s: string) => void statuses.push(`${id}:${s}`),
  });
  return { svc: svc as unknown as TasksService, statuses, rows };
}

const sub = (o: Partial<Row>): Row => ({ id: 's0', title: 't', prompt: 'p', status: 'running', agentName: 'researcher', parentId: 'P', ...o });
const P: Row = { id: 'P', title: 'lead', prompt: 'lead', status: 'running', agentName: 'pm', parentId: null };

describe('an agent does not multiply subtasks', () => {
  it('a request for the same work as an open or finished subtask is answered with that subtask', async () => {
    const { svc, rows } = make([P, sub({ id: 's1', prompt: 'Compare prices of the DS18B20 temperature sensor at five suppliers and make a table', status: 'running' })]);
    const r = (await svc.createSubtask('P', { prompt: 'compare prices of the DS18B20 temperature sensor at five suppliers, and make a table', agentName: 'researcher' }, undefined, { fromAgent: true })) as { id: string; reused?: boolean };
    expect(r.reused).toBe(true);
    expect(r.id).toBe('s1');
    expect(rows.length).toBe(2); // nothing new
  });
  it('different work, a different agent, or a failed earlier attempt gets a new subtask', async () => {
    const { svc, rows } = make([P, sub({ id: 's1', prompt: 'Compare prices of the DS18B20 sensor at five suppliers and make a table', status: 'running' }), sub({ id: 's2', prompt: 'Write the firmware loop that reads the sensor over OneWire', status: 'failed', agentName: 'coder' })]);
    await svc.createSubtask('P', { prompt: 'Write the schematic notes for the power supply of the board', agentName: 'researcher' }, undefined, { fromAgent: true });
    await svc.createSubtask('P', { prompt: 'Compare prices of the DS18B20 sensor at five suppliers and make a table', agentName: 'coder' }, undefined, { fromAgent: true });
    await svc.createSubtask('P', { prompt: 'Write the firmware loop that reads the sensor over OneWire', agentName: 'coder' }, undefined, { fromAgent: true });
    expect(rows.length).toBe(6);
  });
  it('a person adding a subtask in the dashboard is not blocked by this', async () => {
    const { svc, rows } = make([P, sub({ id: 's1', prompt: 'Compare prices of the DS18B20 sensor at five suppliers and make a table' })]);
    await svc.createSubtask('P', { prompt: 'Compare prices of the DS18B20 sensor at five suppliers and make a table', agentName: 'researcher' });
    expect(rows.length).toBe(3);
  });
  it('there is a cap per task', async () => {
    const rows: Row[] = [P, ...Array.from({ length: 25 }, (_, i) => sub({ id: `s${i}`, prompt: `unrelated unit number ${i} of the work`, status: 'done', agentName: 'x' }))];
    const { svc } = make(rows);
    await expect(svc.createSubtask('P', { prompt: 'one more thing entirely different' }, undefined, { fromAgent: true })).rejects.toThrow(/limit 25/);
  });
});

describe('a lead closes its own subtasks', () => {
  it('accepts a finished one, refuses a running one, a cancelled one and a stranger', async () => {
    const { svc, statuses } = make([P, sub({ id: 'a', status: 'blocked' }), sub({ id: 'b', status: 'running' }), sub({ id: 'c', status: 'cancelled' }), sub({ id: 'd', status: 'done' }), sub({ id: 'x', parentId: 'OTHER', status: 'failed' })]);
    expect(await svc.completeSubtask('P', 'a')).toContain('marked done');
    expect(statuses).toEqual(['a:done']);
    expect(await svc.completeSubtask('P', 'b')).toContain('still running');
    expect(await svc.completeSubtask('P', 'c')).toContain('cancelled');
    expect(await svc.completeSubtask('P', 'd')).toContain('already done');
    expect(await svc.completeSubtask('P', 'x')).toContain('No subtask');
    expect(statuses).toEqual(['a:done']);
  });
});
