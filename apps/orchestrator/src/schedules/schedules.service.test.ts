import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SchedulesService } from './schedules.service';

type Row = Record<string, unknown> & { id: string };

/** Minimal in-memory stand-in for the parts of Prisma the scheduler uses. */
function fakeEnv(rows: Row[]) {
  const prisma = {
    task: { update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => ({ id: where.id, ...data })) },
    schedule: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
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
  const files: { channelId: string; chatId: string; names: string[]; mimes: string[]; caption?: string }[] = [];
  const manager = {
    sendText: vi.fn(async (channelId: string, chatId: string, text: string) => (sent.push({ channelId, chatId, text }), true)),
    sendFiles: vi.fn(async (channelId: string, chatId: string, fs: { filename: string; mime: string }[], caption?: string) => (files.push({ channelId, chatId, names: fs.map((f) => f.filename), mimes: fs.map((f) => f.mime), caption }), true)),
  };
  const tasks = {
    create: vi.fn(async () => ({ id: 't1', title: '⏰ x' })),
    get: vi.fn(async (id: string) => ({ id, createdAt: new Date() })),
    followUp: vi.fn(async () => ({})),
  };
  const channels = { linkThread: vi.fn(async () => undefined), setChatState: vi.fn(async () => undefined), chatState: vi.fn(async () => ({ activeTaskId: null as string | null })) };
  const svc = new SchedulesService(prisma as never, tasks as never, channels as never, manager as never, {} as never);
  return { svc, prisma, manager, tasks, channels, sent, files, rows };
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
    expect(env.channels.setChatState).toHaveBeenCalledWith('c1', '42', { activeTaskId: 't1' });
    expect(env.sent[0]!.text).toContain('started');
  });

  it('a task schedule does not take over a chat where a person is in the middle of a conversation (C-16)', async () => {
    const env = fakeEnv([base({ kind: 'task', agentName: 'tutor', text: 'Lesson' })]);
    env.channels.chatState.mockResolvedValue({ activeTaskId: 'mine' });
    env.tasks.get.mockImplementation(async (id: string) => ({ id, createdAt: new Date(), status: id === 'mine' ? 'running' : 'review', updatedAt: new Date() }));
    await env.svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(env.channels.linkThread).toHaveBeenCalledWith('c1', 't1', '42'); // updates still flow to the chat
    expect(env.channels.setChatState).not.toHaveBeenCalled();
    expect(env.sent[0]!.text).toContain('started');

    // a conversation that ended long ago is not "in progress": the chat follows the scheduled task
    const idle = fakeEnv([base({ kind: 'task', agentName: 'tutor', text: 'Lesson' })]);
    idle.channels.chatState.mockResolvedValue({ activeTaskId: 'old' });
    idle.tasks.get.mockImplementation(async (id: string) => ({ id, createdAt: new Date(), status: 'review', updatedAt: new Date(Date.now() - 3 * 3600_000) }));
    await idle.svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(idle.channels.setChatState).toHaveBeenCalledWith('c1', '42', { activeTaskId: 't1' });
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

describe('SchedulesService.update — moving a "same" schedule to another chat (C-17)', () => {
  function env() {
    const row: Row = base({ kind: 'task', agentName: 'tutor', taskMode: 'same', taskId: 't-old', channelId: 'c1', chatId: '42', createdAt: new Date() });
    const prisma = {
      schedule: {
        findUnique: vi.fn(async () => row),
        update: vi.fn(async ({ data }: { data: Row }) => ({ ...row, ...data })),
      },
    };
    const channels = { getRow: vi.fn(async () => ({ id: 'c1' })), allowedChatIds: vi.fn(() => ['42', '43']) };
    const agents = { get: vi.fn(async () => ({ name: 'tutor' })) };
    const svc = new SchedulesService(prisma as never, {} as never, channels as never, {} as never, agents as never);
    return { svc, prisma };
  }

  it('a new chat id drops the old task (its thread was bound to the old chat)', async () => {
    const { svc, prisma } = env();
    await svc.update('s1', { chatId: '43' });
    expect(prisma.schedule.update.mock.calls[0]![0]).toMatchObject({ data: { chatId: '43', taskId: null } });
  });

  it('editing only the text keeps the task', async () => {
    const { svc, prisma } = env();
    await svc.update('s1', { text: 'Practise 15 minutes' });
    expect(prisma.schedule.update.mock.calls[0]![0].data).not.toHaveProperty('taskId');
  });
});

describe('approvals for the tasks a schedule starts', () => {
  const taskRow = (over: Partial<Row> = {}) => base({ kind: 'task', agentName: 'tutor', channelId: null, chatId: null, taskMode: 'same', taskId: null, ...over });
  const due = new Date('2026-10-08T09:30:20Z');

  it('a schedule with approvals off puts that level on the task it starts', async () => {
    const { svc, prisma } = fakeEnv([taskRow({ approvalMode: 'off' })]);
    await svc.tick(due);
    expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { approvalMode: 'off' } });
  });
  it('and on the ongoing task it continues', async () => {
    const { svc, prisma } = fakeEnv([taskRow({ approvalMode: 'off', taskId: 't9' })]);
    await svc.tick(due);
    expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: 't9' }, data: { approvalMode: 'off' } });
  });
  it('no level on the schedule: the task is left to follow the project / global setting', async () => {
    const { svc, prisma } = fakeEnv([taskRow({ approvalMode: null })]);
    await svc.tick(due);
    expect(prisma.task.update).not.toHaveBeenCalled();
  });
  it('a level that is not ask / off is ignored, never written to a task', async () => {
    const { svc, prisma } = fakeEnv([taskRow({ approvalMode: 'whatever' })]);
    await svc.tick(due);
    expect(prisma.task.update).not.toHaveBeenCalled();
  });
  it('the input is checked: ask, off and inherit are accepted, anything else is refused', async () => {
    const { svc } = fakeEnv([]);
    const ok = { name: 'Chart', cron: '30 9 * * *', kind: 'message', text: 'x', channelId: undefined };
    expect(await svc.validate({ ...ok, approvalMode: 'bogus' } as never)).toMatch(/approvalMode must be/);
  });
});

describe('script schedules', () => {
  const script = (over: Partial<Row> = {}) => base({ kind: 'script', name: 'nightly', text: 'echo hello from the script', timeoutSec: null, notifyOn: 'always', lastOutput: null, ...over });

  it('runs the script, keeps its output, posts the result to the chat and records ok', async () => {
    const { svc, rows, sent } = fakeEnv([script()]);
    expect(await svc.tick(new Date('2026-10-08T09:30:20Z'))).toBe(1);
    expect(rows[0]).toMatchObject({ lastStatus: 'ok', lastError: null });
    expect(String(rows[0]!.lastOutput)).toContain('hello from the script');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/^⏰ nightly: ✅ done in \d+ s\nhello from the script/);
  });

  it('a failing script is an error with its exit code, and the chat hears about it', async () => {
    const { svc, rows, sent } = fakeEnv([script({ text: 'echo broken 1>&2; exit 4' })]);
    await svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(rows[0]).toMatchObject({ lastStatus: 'error', lastError: 'exit code 4' });
    expect(sent[0]!.text).toContain('❌ exit code 4');
    expect(sent[0]!.text).toContain('broken');
  });

  it('notifyOn "failure": a good run stays quiet, a bad one speaks', async () => {
    const quiet = fakeEnv([script({ notifyOn: 'failure' })]);
    await quiet.svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(quiet.sent).toHaveLength(0);
    expect(quiet.rows[0]).toMatchObject({ lastStatus: 'ok' });
    const loud = fakeEnv([script({ notifyOn: 'failure', text: 'exit 1' })]);
    await loud.svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(loud.sent).toHaveLength(1);
  });

  it('stops a script at its time limit', async () => {
    const { svc, rows } = fakeEnv([script({ text: 'sleep 20', timeoutSec: 1 })]);
    await svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(rows[0]).toMatchObject({ lastStatus: 'error', lastError: 'stopped after 1 s (time limit)' });
  });

  it('is skipped while the previous run is still working', async () => {
    const { svc, rows } = fakeEnv([script({ text: 'sleep 2' })]);
    const first = svc.runNow('s1');
    await new Promise((r) => setTimeout(r, 200));
    expect(await svc.runNow('s1')).toMatchObject({ status: 'skipped', error: 'the previous run is still working' });
    await first;
    expect(rows[0]).toMatchObject({ lastStatus: 'ok' }); // the run that was working finishes last and records its own result
  });

  it('only an operator (allowScript) may create or change one: not an agent, not a pack', async () => {
    const { svc } = fakeEnv([]);
    const input = { name: 'job', cron: '0 * * * *', kind: 'script', text: 'echo hi', channelId: 'c1', chatId: '42' };
    expect(await svc.validate(input)).toMatch(/only be created or changed in the dashboard/);
    expect(await svc.validate({ ...input, channelId: null, chatId: null }, undefined, { allowScript: true })).toBeNull();
    expect(await svc.validate({ ...input, channelId: null, chatId: null, timeoutSec: 0 }, undefined, { allowScript: true })).toMatch(/time limit/);
    expect(await svc.validate({ ...input, channelId: null, chatId: null, notifyOn: 'sometimes' }, undefined, { allowScript: true })).toMatch(/notifyOn/);
    // an existing script row cannot be toggled by an agent either
    expect(await svc.validate({ enabled: false }, script() as never)).toMatch(/only be created or changed in the dashboard/);
  });
});

describe('script schedules — files and data', () => {
  const script = (over: Partial<Row> = {}) => base({ kind: 'script', name: 'chart', id: `sc-${Math.random().toString(36).slice(2, 8)}`, text: 'echo drawn', timeoutSec: null, notifyOn: 'always', lastOutput: null, ...over });

  it('files the script leaves in $LDS_OUTPUT_DIR are posted to the chat (pictures as photos) and then deleted', async () => {
    const { svc, files, sent, rows } = fakeEnv([script({ text: 'echo "$LDS_OUTPUT_DIR" > /tmp/lds-out-path.txt; printf PNGDATA > "$LDS_OUTPUT_DIR/chart.png"; printf a,b > "$LDS_OUTPUT_DIR/data.csv"; echo EUR 48.1' })]);
    await svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ channelId: 'c1', chatId: '42', names: ['chart.png', 'data.csv'], mimes: ['image/png', 'text/csv'] });
    expect(files[0]!.caption).toMatch(/^⏰ chart\nEUR 48\.1/);
    expect(sent).toHaveLength(0); // the result went as the caption, not as a second message
    expect(rows[0]).toMatchObject({ lastStatus: 'ok' });
    const { existsSync, readFileSync } = await import('node:fs');
    expect(existsSync(readFileSync('/tmp/lds-out-path.txt', 'utf8').trim())).toBe(false); // nothing stays on disk
  });

  it('a script with no chat sends no files; the output folder is still cleaned', async () => {
    const { svc, files, rows } = fakeEnv([script({ channelId: null, chatId: null, text: 'printf x > "$LDS_OUTPUT_DIR/a.png"' })]);
    await svc.tick(new Date('2026-10-08T09:30:20Z'));
    expect(files).toHaveLength(0);
    expect(rows[0]).toMatchObject({ lastStatus: 'ok' });
  });

  it('$LDS_DATA_DIR keeps its files between runs (a history)', async () => {
    const row = script({ text: 'echo x >> "$LDS_DATA_DIR/history.txt"; wc -l < "$LDS_DATA_DIR/history.txt"', channelId: null, chatId: null });
    const { svc, rows } = fakeEnv([row]);
    await svc.runNow(row.id);
    await svc.runNow(row.id);
    expect(String(rows[0]!.lastOutput).trim()).toBe('2');
  });
});
