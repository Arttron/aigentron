import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  classifyToolCall,
  CONTINUE_RUN_TOOL,
  type ApprovalRequest,
  type ApprovalStatus,
  type HookCheckInput,
  type HookCheckResponse,
} from '@lds/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { AgentEventBus } from '../bus/agent-event-bus';
import { SettingsService } from '../settings/settings.service';
import { TasksService, serializeTask } from '../tasks/tasks.service';
import { Prisma } from '../generated/prisma/client';

/** Prisma row shape for an approval (Json/Date fields). */
type ApprovalRow = Awaited<ReturnType<PrismaService['approvalRequest']['create']>>;

/** Serialize a Prisma approval row into the wire-facing shared shape. */
export function serializeApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    taskId: row.taskId,
    agentSessionId: row.agentSessionId,
    toolName: row.toolName,
    toolInput: (row.toolInput ?? {}) as Record<string, unknown>,
    summary: row.summary,
    reason: row.reason,
    status: row.status,
    resolvedBy: row.resolvedBy,
    resolvedById: row.resolvedById,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/**
 * Human-in-the-loop approval gate. The PreToolUse hook (running inside an
 * agent) calls `check` before every tool use; dangerous calls are persisted as
 * pending approvals and the agent blocks on `waitForVerdict` until a human
 * decides — or the request times out and we fail closed (deny).
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: AgentEventBus,
    private readonly settings: SettingsService,
    private readonly tasks: TasksService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Classify a pending tool call. Benign calls are allowed inline; dangerous
   * ones create a pending approval and move the task to `needs_approval`.
   */
  async check(input: HookCheckInput): Promise<HookCheckResponse> {
    const verdict = classifyToolCall(input.toolName, input.toolInput, {
      workspaceRoot: input.workspaceRoot,
    });
    if (!verdict.dangerous) {
      return { allow: true };
    }

    // Honor allowlist exceptions added from the approval dialog (task-scoped or
    // global) — a matching call is auto-approved without asking again.
    if (await this.isAllowedByException(input.taskId, input.toolName, verdict.summary)) {
      this.logger.log(`Auto-approved by exception: ${input.toolName} — ${verdict.summary}`);
      return { allow: true };
    }

    // Loop guard: if this EXACT action (tool + signature) has already been gated
    // this many times on the task, auto-deny instead of raising yet another
    // identical prompt — a run repeating the same dangerous action isn't making
    // progress. Blocks the tool cleanly; the run continues/ends normally.
    const repeats = await this.prisma.approvalRequest.count({
      where: { taskId: input.taskId, toolName: input.toolName, summary: verdict.summary },
    });
    if (this.config.approvalRepeatLimit > 0 && repeats >= this.config.approvalRepeatLimit) {
      this.logger.warn(
        `Auto-denying repeated action (${repeats}×) on task ${input.taskId}: ${input.toolName} — ${verdict.summary}`,
      );
      return {
        allow: false,
        reason: `Refused: this exact action was already gated ${repeats}× on this task — it isn't making progress. Change approach.`,
      };
    }

    const approval = await this.prisma.approvalRequest.create({
      data: {
        taskId: input.taskId,
        agentSessionId: input.agentSessionId ?? null,
        toolName: input.toolName,
        toolInput: input.toolInput as Prisma.InputJsonValue,
        summary: verdict.summary,
        reason: verdict.reason,
        status: 'pending',
      },
    });

    this.bus.publish({ type: 'approval-created', payload: { approval: serializeApproval(approval) } });
    await this.tasks.setStatus(input.taskId, 'needs_approval');
    this.logger.log(`Approval ${approval.id} pending for task ${input.taskId}: ${verdict.reason}`);

    return { allow: false, approvalId: approval.id, reason: verdict.reason };
  }

  /**
   * Block until the approval is resolved, or until `timeoutMs` elapses — in
   * which case it is marked `timeout` (fail-closed: the hook treats this as a
   * deny). Resolves immediately if the verdict already landed.
   */
  async waitForVerdict(id: string, timeoutMs?: number): Promise<ApprovalRequest> {
    await this.getRow(id); // existence check (404s on unknown id)
    const limit = timeoutMs ?? (await this.settings.approvalTimeoutSeconds()) * 1000;

    return new Promise<ApprovalRequest>((resolve, reject) => {
      let settled = false;
      const settle = (value: ApprovalRequest): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        reject(err);
      };

      const recheck = (): void => {
        this.getRow(id)
          .then((row) => {
            if (row.status !== 'pending') settle(serializeApproval(row));
          })
          .catch(fail);
      };

      const unsubscribe = this.bus.subscribe((event) => {
        if (event.type === 'approval-resolved' && event.payload.approvalId === id) recheck();
      });
      const timer = setTimeout(() => {
        this.timeout(id).then(settle).catch(fail);
      }, limit);

      // Cover the race where the verdict landed before we subscribed.
      recheck();
    });
  }

  /** Record a human verdict and let the blocked agent proceed. */
  async decide(
    id: string,
    decision: 'approve' | 'deny',
    resolver?: { id?: string; displayName: string },
    options?: { taskException?: boolean; globalException?: boolean },
  ): Promise<ApprovalRequest> {
    const current = await this.getRow(id);
    if (current.status !== 'pending') {
      throw new ConflictException(`Approval ${id} already resolved (${current.status})`);
    }

    const isContinuation = current.toolName === CONTINUE_RUN_TOOL;

    // On approve, optionally remember this call so it isn't asked again
    // (meaningless for a continuation prompt — skip it there).
    if (decision === 'approve' && !isContinuation) {
      if (options?.taskException) await this.addException('task', current.taskId, current);
      if (options?.globalException) await this.addException('global', null, current);
    }

    const status: ApprovalStatus = decision === 'approve' ? 'approved' : 'denied';
    const updated = await this.prisma.approvalRequest.update({
      where: { id },
      data: {
        status,
        resolvedBy: resolver?.displayName?.trim() || 'human',
        resolvedById: resolver?.id ?? null,
        resolvedAt: new Date(),
      },
    });

    this.bus.publish({
      type: 'approval-resolved',
      payload: { approvalId: id, taskId: updated.taskId, status, ts: new Date().toISOString() },
    });
    this.logger.log(`Approval ${id} ${status} by ${updated.resolvedBy}`);

    if (isContinuation) {
      // The run had already ended (out of steps) — nothing is waiting to unblock.
      // Approve → re-run to continue; Deny → give up.
      if (decision === 'approve') {
        await this.tasks.continueRun(
          updated.taskId,
          'Continue the task from where you left off — the previous run reached its step limit. Finish the remaining work, then report your status.',
        );
      } else {
        await this.tasks.setStatus(updated.taskId, 'stalled', 'continuation denied by human');
      }
    } else {
      await this.resumeTaskIfClear(updated.taskId);
    }

    return serializeApproval(updated);
  }

  /** How many continuation prompts this task has already had (its "grind" count). */
  async continuationCount(taskId: string): Promise<number> {
    return this.prisma.approvalRequest.count({
      where: { taskId, toolName: CONTINUE_RUN_TOOL },
    });
  }

  /**
   * Raise a "the run hit its step limit — continue?" approval. Unlike a tool-call
   * approval, no agent is blocked waiting; approving re-runs the task (see decide).
   */
  async requestContinuation(taskId: string, note?: string): Promise<void> {
    const approval = await this.prisma.approvalRequest.create({
      data: {
        taskId,
        agentSessionId: null,
        toolName: CONTINUE_RUN_TOOL,
        toolInput: {},
        summary: 'The agent reached its step limit before finishing this task.',
        reason: note ?? 'Approve to continue the run for more steps, or deny to stop.',
        status: 'pending',
      },
    });
    this.bus.publish({ type: 'approval-created', payload: { approval: serializeApproval(approval) } });
    await this.tasks.setStatus(taskId, 'needs_approval');
    this.logger.log(`Continuation approval ${approval.id} pending for task ${taskId}`);
  }

  /** List approvals, optionally filtered by status (newest first). */
  async list(status?: ApprovalStatus) {
    return this.prisma.approvalRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string): Promise<ApprovalRequest> {
    return serializeApproval(await this.getRow(id));
  }

  /** True if a global (or this-task) exception allowlists this tool + signature. */
  private async isAllowedByException(
    taskId: string,
    toolName: string,
    signature: string,
  ): Promise<boolean> {
    const match = await this.prisma.approvalException.findFirst({
      where: {
        toolName,
        signature,
        OR: [{ scope: 'global' }, { scope: 'task', taskId }],
      },
      select: { id: true },
    });
    return Boolean(match);
  }

  /** Add an allowlist rule from an approval (idempotent). */
  private async addException(
    scope: 'task' | 'global',
    taskId: string | null,
    approval: { toolName: string; summary: string },
  ): Promise<void> {
    const where = { scope, taskId, toolName: approval.toolName, signature: approval.summary };
    const existing = await this.prisma.approvalException.findFirst({ where, select: { id: true } });
    if (existing) return;
    await this.prisma.approvalException.create({ data: where });
    this.logger.log(`Added ${scope} approval exception: ${approval.toolName} — ${approval.summary}`);
  }

  /** Flip a still-pending approval to `timeout` and fan out the resolution. */
  private async timeout(id: string): Promise<ApprovalRequest> {
    const flipped = await this.prisma.approvalRequest.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'timeout', resolvedBy: 'system:timeout', resolvedAt: new Date() },
    });
    const row = await this.getRow(id);
    if (flipped.count > 0) {
      this.bus.publish({
        type: 'approval-resolved',
        payload: { approvalId: id, taskId: row.taskId, status: 'timeout', ts: new Date().toISOString() },
      });
      await this.resumeTaskIfClear(row.taskId);
      this.logger.warn(`Approval ${id} timed out — denied (fail-closed)`);
    }
    return serializeApproval(row);
  }

  /** Return a task to `running` once it has no more pending approvals. */
  private async resumeTaskIfClear(taskId: string): Promise<void> {
    const pending = await this.prisma.approvalRequest.count({
      where: { taskId, status: 'pending' },
    });
    if (pending > 0) return;
    // Atomic, status-guarded flip: only a task still blocked on approval moves
    // back to running. This can't resurrect one that was cancelled/finished in
    // the meantime (the guard simply matches nothing).
    const flipped = await this.prisma.task.updateMany({
      where: { id: taskId, status: 'needs_approval' },
      data: { status: 'running' },
    });
    if (flipped.count === 0) return;
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return;
    const ts = new Date().toISOString();
    this.bus.publish({ type: 'task-status', payload: { taskId, status: 'running', ts } });
    this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(task) } });
  }

  private async getRow(id: string): Promise<ApprovalRow> {
    const row = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Approval ${id} not found`);
    return row;
  }
}
