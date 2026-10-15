import { describe, expect, it, vi } from 'vitest';
import { BootReconcileService } from './boot-reconcile.service';

function make(fail = false) {
  const upd = (n: number) => vi.fn(async () => { if (fail) throw new Error('db down'); return { count: n }; });
  const prisma = { approvalRequest: { updateMany: upd(2) }, agentQuestion: { updateMany: upd(1) }, task: { updateMany: upd(3) } };
  return { prisma, svc: new BootReconcileService(prisma as never) };
}

describe('BootReconcileService', () => {
  it('times out pending approvals/questions and stalls needs_approval tasks', async () => {
    const { prisma, svc } = make();
    const now = new Date('2026-10-15T00:00:00Z');
    expect(await svc.reconcileOnBoot(now)).toEqual({ approvals: 2, questions: 1, tasks: 3 });
    expect(prisma.approvalRequest.updateMany).toHaveBeenCalledWith({ where: { status: 'pending' }, data: { status: 'timeout', resolvedBy: 'system:restart', resolvedAt: now } });
    expect(prisma.agentQuestion.updateMany).toHaveBeenCalledWith({ where: { status: 'pending' }, data: { status: 'timeout', answeredAt: now } });
    expect(prisma.task.updateMany.mock.calls[0]![0].where).toEqual({ status: 'needs_approval' });
    expect(prisma.task.updateMany.mock.calls[0]![0].data.status).toBe('stalled');
  });
  it('never throws on start', async () => {
    await expect(make(true).svc.onModuleInit()).resolves.toBeUndefined();
  });
});
