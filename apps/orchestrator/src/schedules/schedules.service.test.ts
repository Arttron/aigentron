import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SchedulesService } from './schedules.service';

type Row = Record<string, unknown> & { id: string };

/** Minimal in-memory stand-in for the parts of Prisma the scheduler uses. */
function fakeEnv(rows: Row[]) {
  const prisma = {
    schedule: {
      findMany: vi.fn(async ({ where }: { where: { enabled: boolean; nextRunAt: { lte: Date } } }) =>
        rows.filter((r) => r.enabled === where.enabled && r.nextRunAt && (r.nextRunAt as Date) <= where.nextRunAt.lte),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; nextRunAt: Date | null }; data: Row }) => {
        const r = rows.find((x) => x.id === where.id && (x.nextRunAt as Date | null)?.getTime() === where.nextRunAt?.getTime());
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        Object.assign(rows.find((x) => x.id === where.id)!, data);
        return rows.find((x) => x.id === where.id);
      }),
    },
  };
  const sent: { channelId: string; chatId: string; text: string }[] = [];
  const manager = { sendText: vi.fn(async (channelId: string, chatId: string, text: string) => (sent.push({ channelId, chatId, text }), true)) };
  const tasks = {
    create: vi.fn(async () => ({ id: 't1', title: '⏰ x' })),
    get: vi.fn(async (id: string) => ({ id, createdAt: new Date() })),
    followUp: vi.fn(async () => ({})),
  };
  const channels = { linkThread: vi.fn(async () => undefined), setChatState: vi.fn(async () => undefined) };
  const svc = new SchedulesService(prisma as never, tasks as never, channels as never, manager as never, {} as never);
  return { svc, prisma, manager, tasks, channels, sent, rows };
}

const base = (over: Partial<Row> = {}): Row => ({
  id: 's1',
  name: 'English',
  enabled: true,
  cron: '30 9 * * *',
  timezone: 'UTC',
  kind: 'message',
  text: 'Practise 10 minutes',
  agentName: null,
  channelId: 'c1',
  chatId: '42',
  quietStart: null,
  quietEnd: null,
  nextRunAt: new Date('2026-10-08T09:30:00Z'),
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  ...over,
});

describe('SchedulesService.tick', () => {
  it('fires a due message, moves the next run to tomorrow and records the result', async () => {
    const { svc, rows, sent } = fakeEnv([base()]);
    const ran = await svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(ran).toBe(1);
    expect(sent).toEqual([{ channelId: 'c1', chatId: '42', text: '⏰ Practise 10 minutes' }]);
    expect((rows[0]!.nextRunAt as Date).toISOString()).toBe('2026-10-09T09:30:00.000Z');
    expect(rows[0]).toMatchObject({ lastStatus: 'ok', lastError: null });
  });

  it('does nothing before the time, and nothing for disabled schedules', async () => {
    const a = fakeEnv([base()]);
    expect(await a.svc.tick(new Date('2026-10-08T09:00:00Z'))).toBe(0);
    const b = fakeEnv([base({ enabled: false })]);
    expect(await b.svc.tick(new Date('2026-10-08T10:00:00Z'))).toBe(0);
    expect(a.sent).toHaveLength(0);
  });

  it('is not double-fired: a second tick right after finds nothing due', async () => {
    const { svc, sent } = fakeEnv([base()]);
    const t = new Date('2026-10-08T09:30:20Z');
    await svc.tick(t);
    await svc.tick(new Date(t.getTime() + 1000));
    expect(sent).toHaveLength(1);
  });

  it('skips a run that falls in quiet hours (and still schedules the next one)', async () => {
    const { svc, rows, sent } = fakeEnv([base({ quietStart: '09:00', quietEnd: '10:00' })]);
    await svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(sent).toHaveLength(0);
    expect(rows[0]).toMatchObject({ lastStatus: 'skipped', lastError: 'quiet hours' });
    expect((rows[0]!.nextRunAt as Date).toISOString()).toBe('2026-10-09T09:30:00.000Z');
  });

  it('does not fire a run that was missed while the server was off (> 2h late), but moves on', async () => {
    const { svc, rows, sent } = fakeEnv([base()]);
    await svc.tick(new Date('2026-10-08T15:00:00Z'));
    expect(sent).toHaveLength(0);
    expect(rows[0]).toMatchObject({ lastStatus: 'skipped' });
    expect((rows[0]!.nextRunAt as Date).toISOString()).toBe('2026-10-09T09:30:00.000Z');
  });

  it('records an error when the chat could not be reached', async () => {
    const env = fakeEnv([base()]);
    env.manager.sendText.mockResolvedValueOnce(false);
    await env.svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(env.rows[0]).toMatchObject({ lastStatus: 'error' });
  });

  it('a task schedule starts a task, binds it to the chat and says so', async () => {
    const env = fakeEnv([base({ kind: 'task', agentName: 'tutor', text: 'Prepare today\'s lesson' })]);
    await env.svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(env.tasks.create).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Prepare today's lesson", agentName: 'tutor', createdByChannel: 'schedule:English' }));
    expect(env.channels.linkThread).toHaveBeenCalledWith('c1', 't1', '42');
    expect(env.sent[0]!.text).toContain('started');
  });

  it('a broken cron disables the schedule instead of looping on errors', async () => {
    const env = fakeEnv([base({ cron: 'not a cron' })]);
    await env.svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(env.rows[0]).toMatchObject({ enabled: false, lastStatus: 'error' });
  });
});

describe('task schedules — one ongoing task (taskMode "same")', () => {
  const taskRow = (over: Partial<Row> = {}) => base({ kind: 'task', agentName: 'tutor', channelId: null, chatId: null, taskMode: 'same', taskId: null, ...over });
  const due = new Date('2026-10-08T09:30:20Z');

  it('the first run creates the task and remembers it; the next run continues it instead of making a new one', async () => {
    const { svc, rows, tasks } = fakeEnv([taskRow()]);
    await svc.tick(due);
    expect(tasks.create).toHaveBeenCalledTimes(1);
    expect(rows[0]!.taskId).toBe('t1');
    // next day
    rows[0]!.nextRunAt = new Date('2026-10-09T09:30:00Z');
    await svc.tick(new Date('2026-10-09T09:30:20Z'));
    expect(tasks.create).toHaveBeenCalledTimes(1);
    expect(tasks.followUp).toHaveBeenCalledWith('t1', 'Practise 10 minutes');
    expect(rows[0]).toMatchObject({ lastStatus: 'ok' });
  });

  it('"new" mode starts a separate task every time and keeps no task id', async () => {
    const { svc, rows, tasks } = fakeEnv([taskRow({ taskMode: 'new' })]);
    await svc.tick(due);
    rows[0]!.nextRunAt = new Date('2026-10-09T09:30:00Z');
    await svc.tick(new Date('2026-10-09T09:30:20Z'));
    expect(tasks.create).toHaveBeenCalledTimes(2);
    expect(tasks.followUp).not.toHaveBeenCalled();
    expect(rows[0]!.taskId ?? null).toBeNull();
  });

  it('skips (not errors) when the previous run is still going and its queue is full', async () => {
    const { svc, rows, tasks } = fakeEnv([taskRow({ taskId: 't9' })]);
    tasks.followUp.mockRejectedValueOnce(new ConflictException('queue full'));
    await svc.tick(due);
    expect(rows[0]).toMatchObject({ lastStatus: 'skipped' });
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('starts a fresh task when the old one is gone or a month old', async () => {
    const gone = fakeEnv([taskRow({ taskId: 'missing' })]);
    gone.tasks.get.mockRejectedValueOnce(new Error('not found'));
    await gone.svc.tick(due);
    expect(gone.tasks.create).toHaveBeenCalledTimes(1);
    expect(gone.rows[0]!.taskId).toBe('t1');

    const old = fakeEnv([taskRow({ taskId: 't-old' })]);
    old.tasks.get.mockResolvedValueOnce({ id: 't-old', createdAt: new Date(Date.now() - 31 * 24 * 3600_000) });
    await old.svc.tick(due);
    expect(old.tasks.create).toHaveBeenCalledTimes(1);
    expect(old.tasks.followUp).not.toHaveBeenCalled();
  });
});
