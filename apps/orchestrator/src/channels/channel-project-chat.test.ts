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
  const channels = { chatState: async () => ({ agent: null, model: null, activeTaskId: active }), linkThread: async () => undefined, setChatState, summarize: async () => 's', getRow: async () => ({ id: 'ch1' }), defaultAgent: () => undefined };
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
  // like the database: the rows that name this chat, or name the channel with no chat
  const make = (rows: { notifyChatId?: string | null }[]) =>
    new ProjectsService({ project: { findMany: vi.fn(async (q: { where: { OR: { notifyChatId: string | null }[] } }) => rows.filter((r) => q.where.OR.some((c) => (c.notifyChatId === '' ? !r.notifyChatId : c.notifyChatId === null ? r.notifyChatId == null : c.notifyChatId === r.notifyChatId)))) } } as never, {} as never, {} as never, {} as never);
  it('one project that names the chat binds it; none or several do not', async () => {
    expect((await make([{ id: 'a', slug: 'a', name: 'A', notifyChatId: 'x' }]).boundToChat('c', 'x'))?.slug).toBe('a');
    expect(await make([]).boundToChat('c', 'x')).toBeNull();
    expect(await make([{ id: 'a', slug: 'a', notifyChatId: 'x' }, { id: 'b', slug: 'b', notifyChatId: 'x' }]).boundToChat('c', 'x')).toBeNull();
    expect(await make([{ id: 'a', slug: 'a', notifyChatId: 'x' }]).boundToChat('', 'x')).toBeNull();
  });
  it('a project that names the CHANNEL without a chat owns every chat of it; a project naming the chat itself wins over it', async () => {
    expect((await make([{ id: 'a', slug: 'a', name: 'A', notifyChatId: null }]).boundToChat('c', 'any-chat'))?.slug).toBe('a');
    expect((await make([{ id: 'a', slug: 'a', notifyChatId: '' }]).boundToChat('c', 'any-chat'))?.slug).toBe('a');
    expect((await make([{ id: 'a', slug: 'a', notifyChatId: null }, { id: 'b', slug: 'b', notifyChatId: 'x' }]).boundToChat('c', 'x'))?.slug).toBe('b');
    expect((await make([{ id: 'a', slug: 'a', notifyChatId: null }, { id: 'b', slug: 'b', notifyChatId: 'x' }]).boundToChat('c', 'other'))?.slug).toBe('a');
    expect(await make([{ id: 'a', slug: 'a', notifyChatId: null }, { id: 'b', slug: 'b', notifyChatId: null }]).boundToChat('c', 'x')).toBeNull(); // two projects claim the whole channel
  });
});

describe('who a new task from a chat goes to', () => {
  function svc(opts: { chat?: string | null; bound?: { slug: string; name: string; id: string; defaultAgent: string | null } | null; channelDefault?: string }) {
    const create = vi.fn(async (d: { agentName?: string }) => ({ id: 'tn', title: 'New one', agentName: d.agentName ?? 'pm-from-project' }));
    const channels = {
      chatState: async () => ({ agent: opts.chat ?? null, model: null, activeTaskId: null }),
      linkThread: async () => undefined,
      setChatState: vi.fn(async () => undefined),
      getRow: async () => ({ id: 'ch1' }),
      defaultAgent: () => opts.channelDefault,
    };
    const agents = { get: async (n: string) => (n === 'gone' ? Promise.reject(new Error('404')) : { name: n }), list: async () => [{ name: 'admin', description: 'platform' }, { name: 'dev', description: 'builds' }, { name: 'support', description: 'answers' }, { name: 'secret-ops', description: 'internal' }] };
    const s = new ChannelCommandService({} as never, {} as never, channels as never, { create } as never, {} as never, {} as never, agents as never, { defaultAgent: async () => 'pm' } as never, {} as never, {} as never, { boundToChat: async () => opts.bound ?? null } as never);
    return { s, create, channels };
  }
  const shop = { id: 'p-shop', slug: 'shop', name: 'Shop', defaultAgent: 'dev' };
  it('the agent named in the message, then the chat\'s own choice', async () => {
    expect((await svc({ chat: 'admin', bound: shop }).s.newTask(ctx, 'x', 'architect')).text).toContain('→ architect');
    const r = await svc({ chat: 'admin', bound: shop }).s.newTask(ctx, 'x');
    expect(r.text).toContain('→ admin');
    expect(r.text).toContain('/agent default'); // a task that went to the chat\'s sticky agent says so
  });
  it('without those: the project\'s default lead (the task applies it), else the channel\'s default agent (it used to be ignored), else the main lead', async () => {
    const withProject = svc({ bound: shop, channelDefault: 'support' });
    await withProject.s.newTask(ctx, 'x');
    expect(withProject.create.mock.calls[0]![0].agentName).toBeUndefined();
    const noProjectAgent = svc({ bound: { ...shop, defaultAgent: null }, channelDefault: 'support' });
    await noProjectAgent.s.newTask(ctx, 'x');
    expect(noProjectAgent.create.mock.calls[0]![0].agentName).toBe('support');
    const none = svc({});
    await none.s.newTask(ctx, 'x');
    expect(none.create.mock.calls[0]![0].agentName).toBeUndefined();
  });
  it('/agent default forgets the chat\'s choice', async () => {
    const { s, channels } = svc({ chat: 'admin' });
    expect(await s.handle(ctx, '/agent default')).toContain('default agent again');
    expect(channels.setChatState).toHaveBeenCalledWith('ch1', 'chat1', { agent: null });
  });
});

describe('review of the channels (Fable): regressions', () => {
  const shopRow = { id: 'p-shop', slug: 'shop', name: 'Shop', defaultAgent: 'support', pinnedAgents: 'support,dev' };
  function chat(bound: typeof shopRow | null, extra: { chatAgent?: string | null } = {}) {
    const start = vi.fn(async () => ({ taskId: 'td' }));
    const channels = {
      chatState: async () => ({ agent: extra.chatAgent ?? null, model: null, activeTaskId: null }),
      linkThread: async () => undefined,
      setChatState: vi.fn(async () => undefined),
      getRow: async () => ({ id: 'ch1' }),
      defaultAgent: () => undefined,
    };
    const agents = { get: async (n: string) => (n === 'gone' ? Promise.reject(new Error('404')) : { name: n }), list: async () => [{ name: 'admin', description: 'platform' }, { name: 'dev', description: 'builds' }, { name: 'support', description: 'answers' }, { name: 'secret-ops', description: 'internal' }] };
    const create = vi.fn(async (d: { agentName?: string }) => ({ id: 'tn', title: 'T', agentName: d.agentName ?? 'x' }));
    const moduleRef = { get: () => ({ start }) };
    const s = new ChannelCommandService({} as never, {} as never, channels as never, { create } as never, {} as never, {} as never, agents as never, { defaultAgent: async () => 'pm' } as never, {} as never, moduleRef as never, { boundToChat: async () => bound } as never);
    return { s, start, create, channels };
  }
  it('/discuss from a bound chat starts the discussion in that project', async () => {
    const { s, start } = chat(shopRow);
    await s.handle(ctx, '/discuss support dev: how do we ship?');
    expect(start.mock.calls[0]![0]).toMatchObject({ project: 'shop' });
    const free = chat(null);
    await free.s.handle(ctx, '/discuss support dev: how do we ship?');
    expect(free.start.mock.calls[0]![0].project).toBeUndefined();
  });
  it("a bound chat sees only the project's agents (and the admin), in /agents, by address and for /agent", async () => {
    const { s } = chat(shopRow);
    const list = (await s.handle(ctx, '/agents')) as string;
    expect(list).toContain('support');
    expect(list).toContain('dev');
    expect(list).not.toContain('secret_ops');
    expect(await s.resolveAddress('/secret-ops do it', ctx)).not.toMatchObject({ agent: 'secret-ops' });
    expect(await s.resolveAddress('/support help me', ctx)).toMatchObject({ agent: 'support', rest: 'help me' });
    expect(await s.handle(ctx, '/agent secret-ops')).toContain('not found');
    expect(await s.handle(ctx, '/agent dev')).toContain('Agent set to dev');
    const open = chat(null);
    expect(((await open.s.handle(ctx, '/agents')) as string)).toContain('secret_ops');
  });
  it("the menu of a channel that belongs to a project lists only that project's agents", async () => {
    const { s } = chat(shopRow);
    const menu = (await s.agentCommands('ch1')).map((c) => c.command);
    expect(menu).toContain('support');
    expect(menu).not.toContain('secret_ops');
    expect(menu).not.toContain('secretops');
    expect((await chat(null).s.agentCommands('ch1')).length).toBeGreaterThan(menu.length);
  });
  it("a chat agent that was deleted does not break the chat: the project's default applies", async () => {
    const { s, create } = chat(shopRow, { chatAgent: 'gone' });
    const r = await s.newTask(ctx, 'hello');
    expect(create.mock.calls[0]![0].agentName).toBeUndefined();
    expect(r.text).not.toContain('this chat\'s agent');
  });
});

describe('the default project never owns a chat, an archived one keeps its chat', () => {
  it('asks only for non-default projects, archived ones included', async () => {
    const findMany = vi.fn(async () => []);
    const svc = new ProjectsService({ project: { findMany } } as never, {} as never, {} as never, {} as never);
    await svc.boundToChat('c', 'x');
    const where = (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ isDefault: false, notifyChannelId: 'c' });
    expect(where).not.toHaveProperty('archivedAt');
  });
});
