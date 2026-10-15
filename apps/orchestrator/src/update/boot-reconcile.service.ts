import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ReconcileResult {
  approvals: number;
  questions: number;
  tasks: number;
}

/**
 * On start: whatever a PREVIOUS process was waiting for is gone with it (the agent that asked, the in-memory waiter). A pending
 * approval or question would otherwise sit forever, and a late "Approve" would flip a task to `running` with no agent behind it.
 * So pending approvals become `timeout`, pending questions `timeout`, and tasks parked in `needs_approval` become `stalled`
 * (terminal and resumable: the person can follow up). Uses prisma directly on purpose - it must not depend on the services it cleans up after.
 */
@Injectable()
export class BootReconcileService implements OnModuleInit {
  private readonly logger = new Logger('BootReconcile');

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const r = await this.reconcileOnBoot();
      if (r.approvals || r.questions || r.tasks) {
        this.logger.warn(`left over from the previous process: ${r.approvals} approval(s) and ${r.questions} question(s) timed out, ${r.tasks} task(s) marked stalled`);
      }
    } catch (e) {
      // never block the start over housekeeping
      this.logger.error(`boot reconcile failed: ${(e as Error).message}`);
    }
  }

  async reconcileOnBoot(now: Date = new Date()): Promise<ReconcileResult> {
    const approvals = await this.prisma.approvalRequest.updateMany({
      where: { status: 'pending' },
      data: { status: 'timeout', resolvedBy: 'system:restart', resolvedAt: now },
    });
    const questions = await this.prisma.agentQuestion.updateMany({
      where: { status: 'pending' },
      data: { status: 'timeout', answeredAt: now },
    });
    const tasks = await this.prisma.task.updateMany({
      where: { status: 'needs_approval' },
      data: { status: 'stalled', error: 'The server restarted while this task waited for an approval - follow up to continue.' },
    });
    return { approvals: approvals.count, questions: questions.count, tasks: tasks.count };
  }
}
