import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelManagerService } from './channel-manager.service';

// two chats on one channel: A belongs to project "shop", B is free
const rows = [{ id: 'tg', enabled: true, kind: 'telegram', config: { botToken: 't', allowedChatIds: ['A', 'B'] } }];
const approval = (taskId: string) => ({ id: `ap-${taskId}`, taskId, summary: 's', reason: 'r', toolName: 'Bash', toolInput: {} });

function make(opts: { focused: boolean; taskProject: string }) {
  const sendApproval = vi.fn(async () => ({ messageId: 'm1' }));
  const prisma = {
    task: { findUnique: vi.fn(async () => ({ projectId: opts.taskProject })) },
    project: { findMany: vi.fn(async () => [{ id: 'shop', notifyChannelId: 'tg', notifyChatId: 'A' }]) },
    approvalRequest: { findUnique: vi.fn(async () => ({ status: 'pending' })) },
  };
  const channels = {
    list: async () => rows,
    isConfigured: () => true,
    allowedChatIds: (r: (typeof rows)[number]) => r.config.allowedChatIds,
    linkMessage: async () => undefined,
  };
  const dest = { destForTask: async () => null };
  const presence = { anyoneFocused: () => opts.focused };
  const gateway = { sendApproval, send: vi.fn() };
  const svc = new ChannelManagerService(prisma as never, {} as never, channels as never, {} as never, {} as never, {} as never, {} as never, {} as never, presence as never, {} as never, {} as never, {} as never, gateway as never, dest as never, {} as never);
  return { svc: svc as unknown as { onApprovalCreated(a: ReturnType<typeof approval>): Promise<void>; escalationTimers: Set<unknown> }, sendApproval };
}
const chatsOf = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => c[1]);

afterEach(() => vi.useRealTimers());

describe('where an approval of a dashboard task goes', () => {
  it("a project with its own chat: straight to that chat, even with the dashboard open, and nowhere else", async () => {
    const { svc, sendApproval } = make({ focused: true, taskProject: 'shop' });
    await svc.onApprovalCreated(approval('t1'));
    expect(chatsOf(sendApproval)).toEqual(['A']);
  });
  it('the default project (no chat of its own): only the free chat, and only when nobody is at the dashboard', async () => {
    vi.useFakeTimers();
    const watched = make({ focused: true, taskProject: 'default' });
    await watched.svc.onApprovalCreated(approval('t2'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(watched.sendApproval).not.toHaveBeenCalled();

    const away = make({ focused: false, taskProject: 'default' });
    await away.svc.onApprovalCreated(approval('t3'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chatsOf(away.sendApproval)).toEqual(['B']); // never A: it belongs to "shop"
  });
});

describe('a channel tied to a project (no chat id) owns every chat of it', () => {
  function makeChannelWide(taskProject: string, opts: { focused?: boolean; settings?: { notifyChannelId: string; notifyChatId: string } | null; target?: { channelId: string; chatId: string | null } | null } = {}) {
    const sendApproval = vi.fn(async () => ({ messageId: 'm1' }));
    const send = vi.fn(async () => ({ messageId: 'm2' }));
    const prisma = {
      task: { findUnique: vi.fn(async () => ({ projectId: taskProject })) },
      project: { findMany: vi.fn(async () => [{ id: 'shop', notifyChannelId: 'client', notifyChatId: null }]) },
      appSettings: { findUnique: vi.fn(async () => opts.settings ?? null) },
      approvalRequest: { findUnique: vi.fn(async () => ({ status: 'pending' })) },
    };
    const rows2 = [
      { id: 'main', enabled: true, kind: 'telegram', config: { botToken: 't', allowedChatIds: ['M1'] } },
      { id: 'client', enabled: true, kind: 'telegram', config: { botToken: 't', allowedChatIds: ['C1', 'C2'] } },
    ];
    const channels = { list: async () => rows2, isConfigured: () => true, allowedChatIds: (r: (typeof rows2)[number]) => r.config.allowedChatIds, linkMessage: async () => undefined, setChatState: async () => undefined, linkThread: async () => undefined, summarize: async () => 's' };
    const projects = { boundToChat: async () => null, notifyTargetFor: async () => opts.target ?? null };
    const dest = { destForTask: async () => null, prefs: async () => ({ muted: false }) };
    const svc = new ChannelManagerService(prisma as never, {} as never, channels as never, {} as never, {} as never, {} as never, {} as never, {} as never, { anyoneFocused: () => opts.focused ?? true } as never, {} as never, {} as never, {} as never, { sendApproval, send } as never, dest as never, projects as never);
    return { svc: svc as unknown as { onApprovalCreated(a: ReturnType<typeof approval>): Promise<void>; notifyOperators(t: string): Promise<void>; notifyDefaultChannel(id: string, title: string, err: string | null, st: string): Promise<void> }, sendApproval, send };
  }
  it("the project's approvals go to the client channel's chats only", async () => {
    const mine = makeChannelWide('shop');
    await mine.svc.onApprovalCreated(approval('t1'));
    expect(chatsOf(mine.sendApproval).sort()).toEqual(['C1', 'C2']);
  });
  it("another project's approvals never reach the client channel, only the free chat", async () => {
    vi.useFakeTimers();
    const other = makeChannelWide('default', { focused: false });
    await other.svc.onApprovalCreated(approval('t2'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chatsOf(other.sendApproval)).toEqual(['M1']);
  });
  it('an escalation (blocked / failed) of the project goes to the channel it owns, not to the global chat', async () => {
    const mine = makeChannelWide('shop', { settings: { notifyChannelId: 'main', notifyChatId: 'M1' }, target: { channelId: 'client', chatId: null } });
    await mine.svc.notifyDefaultChannel('t1', 'Fix it', 'stuck', 'blocked');
    expect(mine.send.mock.calls.map((c) => [c[0], c[1]]).sort()).toEqual([['client', 'C1'], ['client', 'C2']]);
  });
  it('a notice for the operators (disk space …) never goes to a chat a project owns', async () => {
    const withGlobal = makeChannelWide('shop', { settings: { notifyChannelId: 'main', notifyChatId: 'M1' } });
    await withGlobal.svc.notifyOperators('disk is low');
    expect(withGlobal.send.mock.calls.map((c) => c[1])).toEqual(['M1']);
    const noGlobal = makeChannelWide('shop');
    await noGlobal.svc.notifyOperators('disk is low');
    expect(noGlobal.send.mock.calls.map((c) => c[1])).toEqual(['M1']); // every allowed chat that is not a project's
    const globalIsProjects = makeChannelWide('shop', { settings: { notifyChannelId: 'client', notifyChatId: 'C1' } });
    await globalIsProjects.svc.notifyOperators('disk is low');
    expect(globalIsProjects.send.mock.calls.map((c) => c[1])).toEqual(['M1']);
  });
});
