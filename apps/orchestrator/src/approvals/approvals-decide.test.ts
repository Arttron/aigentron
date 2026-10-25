import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { CONTINUE_RUN_TOOL } from '@lds/shared';

/** A fake approval table in which `pending` rows can be claimed exactly once, like the real guarded update. */
function make(toolName = 'Bash') {
  const row = { id: 'a1', taskId: 't1', toolName, toolInput: {}, summary: 's', reason: 'r', status: 'pending' as string, resolvedBy: null as string | null, resolvedById: null, resolvedAt: null, createdAt: new Date(), taskStatus: null };
  const updateMany = vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
    if (row.status !== where.status) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const prisma = {
    approvalRequest: { findUnique: vi.fn(async () => ({ ...row })), updateMany, findMany: vi.fn(async () => []) },
    approvalException: { upsert: vi.fn(async () => undefined) },
  };
  const bus = { publish: vi.fn() };
  const tasks = { continueRun: vi.fn(async () => undefined), setStatus: vi.fn(async () => undefined), getLite: vi.fn(async () => ({ status: 'needs_approval' })) };
  const svc = new ApprovalsService(prisma as never, bus as never, {} as never, tasks as never, { secretsDir: '/nonexistent' } as never, { get: () => null } as never);
  (svc as unknown as { resumeTaskIfClear: () => Promise<void> }).resumeTaskIfClear = async () => undefined;
  return { svc, bus, tasks, row };
}

describe('deciding an approval is atomic', () => {
  it('two answers at the same moment: one wins, the other is told it is resolved, and the effects happen once', async () => {
    const { svc, bus } = make();
    const results = await Promise.allSettled([svc.decide('a1', 'approve', { displayName: 'dock' }), svc.decide('a1', 'deny', { displayName: 'telegram' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ConflictException);
    expect(bus.publish).toHaveBeenCalledTimes(1);
  });
  it('a continuation approved twice re-runs the task once', async () => {
    const { svc, tasks } = make(CONTINUE_RUN_TOOL);
    await Promise.allSettled([svc.decide('a1', 'approve', { displayName: 'dock' }), svc.decide('a1', 'approve', { displayName: 'telegram' })]);
    expect(tasks.continueRun).toHaveBeenCalledTimes(1);
  });
  it('a later answer to a resolved card is a conflict, and who decided first is kept', async () => {
    const { svc, row } = make();
    await svc.decide('a1', 'approve', { displayName: 'first' });
    await expect(svc.decide('a1', 'deny', { displayName: 'second' })).rejects.toBeInstanceOf(ConflictException);
    expect(row.status).toBe('approved');
    expect(row.resolvedBy).toBe('first');
  });
});
