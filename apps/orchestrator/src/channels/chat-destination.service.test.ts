import { describe, expect, it, vi } from 'vitest';
import { ChatDestinationService } from './chat-destination.service';

function make(threads: Record<string, { channelId: string; externalThreadId: string }>, parents: Record<string, string | null> = {}) {
  const prisma = {
    channelThread: { findFirst: vi.fn(async ({ where }: { where: { taskId: string } }) => threads[where.taskId] ?? null) },
    task: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id in parents ? { parentId: parents[where.id] } : null)) },
    channelChatState: { findUnique: vi.fn(async () => ({ muted: true, progress: false, voice: true })) },
  };
  return { svc: new ChatDestinationService(prisma as never), prisma };
}

describe('ChatDestinationService.destForTask (C-09)', () => {
  it('a task with its own thread speaks there', async () => {
    const { svc } = make({ t1: { channelId: 'c1', externalThreadId: '42' } });
    expect(await svc.destForTask('t1')).toEqual({ channelId: 'c1', chatId: '42', own: true });
  });

  it("a subtask without a thread speaks in its parent's chat (own = false)", async () => {
    const { svc } = make({ p: { channelId: 'c1', externalThreadId: '42' } }, { sub: 'p' });
    expect(await svc.destForTask('sub')).toEqual({ channelId: 'c1', chatId: '42', own: false });
  });

  it('a dashboard task (no thread, no parent with one) has no chat', async () => {
    const { svc } = make({}, { d: null, sub: 'p' });
    expect(await svc.destForTask('d')).toBeNull();
    expect(await svc.destForTask('sub')).toBeNull();
    expect(await svc.destForTask('unknown')).toBeNull();
  });
});

describe('ChatDestinationService.prefs cache (C-23)', () => {
  it('serves repeated reads from memory and forgets on invalidate', async () => {
    const { svc, prisma } = make({});
    expect(await svc.prefs('c1', '42')).toEqual({ muted: true, progress: false, voice: true });
    await svc.prefs('c1', '42');
    await svc.prefs('c1', '42');
    expect(prisma.channelChatState.findUnique).toHaveBeenCalledTimes(1);
    svc.invalidate('c1', '42');
    await svc.prefs('c1', '42');
    expect(prisma.channelChatState.findUnique).toHaveBeenCalledTimes(2);
    await svc.prefs('c1', '43'); // another chat is its own entry
    expect(prisma.channelChatState.findUnique).toHaveBeenCalledTimes(3);
  });

  it('a chat without a state row has everything off', async () => {
    const { svc, prisma } = make({});
    prisma.channelChatState.findUnique.mockResolvedValueOnce(null as never);
    expect(await svc.prefs('c1', '1')).toEqual({ muted: false, progress: false, voice: false });
  });
});
