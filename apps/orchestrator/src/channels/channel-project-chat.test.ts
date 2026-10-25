import { describe, expect, it, vi } from 'vitest';
import { ChannelCommandService } from './channel-commands.service';
import { ProjectsService } from '../projects/projects.service';

const ctx = { channelId: 'ch1', chatId: 'chat1', userId: 'u', kind: 'telegram' };
const shop = { id: 'p-shop', slug: 'shop', name: 'Shop' };

function service(bound: unknown, taskProject = 'p-other', active: string | null = null) {
  const list = vi.fn(async (p: { project?: string }) => ({ items: p.project ? [{ id: 't1', title: 'In shop', status: 'done' }] : [{ id: 't1', title: 'In shop', status: 'done' }, { id: 't2', title: 'Elsewhere', status: 'done' }] }));
  const create = vi.fn(async () => ({ id: 'tn', title: 'New one' }));
  const tasks = { list, create, get: async (id: string) => ({ id, title: 'T', status: 'done', projectId: taskProject }) };
  const setChatState = vi.fn(async () => undefined);
  const channels = { chatState: async () => ({ agent: null, model: null, activeTaskId: active }), linkThread: async () => undefined, setChatState, summarize: async () => 's' };
  const prisma = { task: { findUnique: async () => ({ projectId: taskProject, title: 'Old', status: 'running', agentName: null, providerOverride: null }), findMany: async () => [] } };
  const settings = { defaultAgent: async () => 'pm', defaultProvider: async () => 'p' };
  const projects = { boundToChat: async () => bound };
  const s = new ChannelCommandService(prisma as never, {} as never, channels as never, tasks as never, {} as never, {} as never, {} as never, settings as never, {} as never, {} as never, projects as never);
  return { s, list, create, setChatState };
}

describe('a chat bound to a project', () => {
  it('/tasks lists only that project, and says so', async () => {
    const { s, list } = service(shop);
    const r = (await s.handle(ctx, '/tasks')) as { text: string; buttons: unknown[][] };
    expect(list).toHaveBeenCalledWith({ pageSize: 10, project: 'shop' });
    expect(r.text).toContain('«Shop»');
    expect(r.buttons).toHaveLength(1);
  });
  it('an unbound chat sees every task as before', async () => {
    const { s, list } = service(null);
    const r = (await s.handle(ctx, '/tasks')) as { text: string; buttons: unknown[][] };
    expect(list).toHaveBeenCalledWith({ pageSize: 10 });
    expect(r.buttons).toHaveLength(2);
  });
  it('a new task from the chat goes into the project (so it shows in /tasks)', async () => {
    const { s, create } = service(shop);
    await s.newTask(ctx, 'do the thing');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ project: 'shop' }));
    const unbound = service(null);
    await unbound.s.newTask(ctx, 'do the thing');
    expect(unbound.create).toHaveBeenCalledWith(expect.objectContaining({ project: undefined }));
  });
  it('switching to a task of another project is refused; of this project it works', async () => {
    expect(await service(shop, 'p-other').s.switchToTaskById(ctx, 't9')).toContain('not in «Shop»');
    expect(await service(shop, 'p-shop').s.switchToTaskById(ctx, 't9')).toContain('Now on');
    expect(await service(null, 'p-other').s.switchToTaskById(ctx, 't9')).toContain('Now on');
  });
});

describe('the rest of a bound chat works only with its project too', () => {
  it("an active task of another project is not 'the active task': /status says none and the chat forgets it", async () => {
    const other = service(shop, 'p-other', 't-old');
    expect(await other.s.handle(ctx, '/status')).toContain('No active task');
    expect(other.setChatState).toHaveBeenCalledWith('ch1', 'chat1', { activeTaskId: null });
    const same = service(shop, 'p-shop', 't-old');
    expect(await same.s.handle(ctx, '/status')).toContain('«Old»');
    const free = service(null, 'p-other', 't-old');
    expect(await free.s.handle(ctx, '/status')).toContain('«Old»');
  });
  it('the settings view names the project', async () => {
    expect(await service(shop, 'p-shop').s.handle(ctx, '/settings')).toContain('Project: «Shop»');
  });
});

describe('ProjectsService.boundToChat', () => {
  const make = (rows: unknown[]) => new ProjectsService({ project: { findMany: vi.fn(async () => rows) } } as never, {} as never, {} as never, {} as never);
  it('one project on that chat binds it; none or several do not', async () => {
    expect((await make([{ id: 'a', slug: 'a', name: 'A' }]).boundToChat('c', 'x'))?.slug).toBe('a');
    expect(await make([]).boundToChat('c', 'x')).toBeNull();
    expect(await make([{ id: 'a', slug: 'a' }, { id: 'b', slug: 'b' }]).boundToChat('c', 'x')).toBeNull();
    expect(await make([{ id: 'a', slug: 'a' }]).boundToChat('', 'x')).toBeNull();
  });
});
