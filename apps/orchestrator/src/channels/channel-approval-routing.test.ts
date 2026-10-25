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
