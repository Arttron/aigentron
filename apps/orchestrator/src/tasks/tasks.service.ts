import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { isTerminalStatus, type Task, type TaskStatus } from '@lds/shared';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { decodeAttachments } from '../prisma/agent-event-attachments';
import { TaskQueue } from '../queue/queue.constants';
import { AgentEventBus } from '../bus/agent-event-bus';
import { WorktreeService } from '../worktrees/worktree.service';
import { AgentExecutor } from '../agent/agent-executor';
import { AgentRegistryService } from '../agent-registry/agent-registry.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { SettingsService } from '../settings/settings.service';
import type { CreateTaskDto } from './dto/create-task.dto';

/** Prisma row shape for a task (dates as Date). */
type TaskRow = Awaited<ReturnType<PrismaService['task']['create']>>;

/** Serialize a Prisma task row into the wire-facing shared Task shape. */
export function serializeTask(row: TaskRow): Task {
  return {
    id: row.id,
    prompt: row.prompt,
    title: row.title,
    status: row.status,
    branch: row.branch,
    worktreePath: row.worktreePath,
    agentName: row.agentName,
    prUrl: row.prUrl,
    pushedTo: row.pushedTo,
    error: row.error,
    createdById: row.createdById,
    parentId: row.parentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Input for a subtask created by a lead agent's decomposition tool. */
export interface SubtaskInput {
  title?: string;
  prompt: string;
  agentName?: string;
}

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly queue: TaskQueue,
    private readonly bus: AgentEventBus,
    private readonly worktrees: WorktreeService,
    private readonly executor: AgentExecutor,
    private readonly agents: AgentRegistryService,
    private readonly attachments: AttachmentsService,
    private readonly settings: SettingsService,
  ) {}

  async create(dto: CreateTaskDto, createdById?: string) {
    // Explicit agent 404s on a bad name; otherwise fall back to the configured
    // default lead (e.g. pm), tolerating its absence.
    let agent = null;
    if (dto.agentName) {
      agent = await this.agents.get(dto.agentName);
    } else {
      const def = await this.settings.defaultAgent();
      if (def) agent = await this.agents.get(def).catch(() => null);
    }
    const title = dto.title?.trim() || deriveTitle(dto.prompt);
    // A subtask's parent must exist; reject a dangling parentId early.
    if (dto.parentId) await this.get(dto.parentId);

    const task = await this.prisma.task.create({
      data: {
        prompt: dto.prompt,
        title,
        status: 'queued',
        agentName: agent?.name ?? null,
        createdById: createdById ?? null,
        parentId: dto.parentId ?? null,
        createdByChannel: dto.createdByChannel ?? null,
        providerOverride: dto.provider?.trim() || null,
      },
    });
    this.logger.log(
      `Created task ${task.id} [agent=${agent?.name ?? 'default'}]` +
        (task.parentId ? ` [parent=${task.parentId}]` : '') +
        ` "${title}"`,
    );
    // Link referenced tasks so their summaries fold into this task's context.
    if (dto.references?.length) await this.linkReferences(task.id, dto.references);
    this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(task) } });
    // Defer queuing when the client will upload attachments first (avoids the
    // run reading the attachments dir before the files land); it then /start-s.
    if (dto.autostart !== false) {
      await this.queue.enqueue({ taskId: task.id, attachments: dto.attachments });
    }
    return task;
  }

  /**
   * Create + enqueue a subtask under a parent. Used by a lead agent's
   * decomposition tool and by the API. Inherits the parent's referenced tasks
   * so a subtask sees the same related context.
   */
  async createSubtask(parentId: string, input: SubtaskInput, createdById?: string) {
    const parent = await this.get(parentId); // 404 if missing
    const inheritedRefs = parent.linksOut?.map((l) => l.toTaskId) ?? [];
    const child = await this.create(
      {
        prompt: input.prompt,
        title: input.title,
        agentName: input.agentName,
        parentId,
        references: inheritedRefs,
      },
      createdById ?? parent.createdById ?? undefined,
    );
    // Mark the parent so it's resumed with results once all subtasks finish.
    await this.prisma.task.update({ where: { id: parentId }, data: { awaitingSubtasks: true } });
    return child;
  }

  /** Current status + latest result of a task's subtasks (for the check_subtasks tool). */
  async subtaskStatuses(
    parentId: string,
  ): Promise<{ id: string; title: string; status: TaskStatus; summary: string }[]> {
    const subs = await this.prisma.task.findMany({
      where: { parentId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, title: true, status: true },
    });
    return Promise.all(
      subs.map(async (s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        summary: await this.summarizeTask(s.id),
      })),
    );
  }

  /**
   * Fan-in: after a task settles, resume its parent (if any) — and itself, if it
   * is a parent — once ALL subtasks have finished, feeding the results back so
   * the lead can synthesize / move to the next phase. Called by the worker.
   */
  async fanInAfterSettle(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { parentId: true, status: true, title: true, error: true },
    });
    if (!task) return;
    // A task that ended needing a human decision (blocked, or stalled with a
    // question left in prose) escalates that question upward: to the lead that
    // created it (subtask) — done here — or, for a top-level task, to the
    // originating/default channel (done by ChannelManagerService off the bus).
    if (task.status === 'blocked' || task.status === 'stalled') {
      await this.escalateNeedsInput(taskId, task).catch((e) =>
        this.logger.warn(`escalation failed for ${taskId}: ${(e as Error).message}`),
      );
    }
    await this.wakeIfSubtasksDone(taskId); // this task may itself be a parent
    if (task.parentId) await this.wakeIfSubtasksDone(task.parentId);
  }

  /**
   * A subtask that needs input wakes its lead IMMEDIATELY (not after all siblings
   * settle) with the question, so the lead can answer it (follow_up on the
   * subtask) or change course. Only fires when the lead is paused waiting on its
   * subtasks; if the lead is still running it's blocked inside `wait_for_task`,
   * which already returns the question to it inline. Top-level tasks escalate to
   * a channel instead (handled by ChannelManagerService), not here.
   */
  private async escalateNeedsInput(
    taskId: string,
    task: { parentId: string | null; title: string; error: string | null },
  ): Promise<void> {
    if (!task.parentId) return; // top-level → channel escalation (bus subscriber)
    const parent = await this.prisma.task.findUnique({
      where: { id: task.parentId },
      select: { status: true, awaitingSubtasks: true, subtasks: { select: { status: true } } },
    });
    if (!parent || !parent.awaitingSubtasks || !isTerminalStatus(parent.status)) return;
    // If this was the LAST outstanding subtask, don't escalate separately: the
    // regular fan-in (wakeIfSubtasksDone, next in fanInAfterSettle) fires now
    // and its per-subtask summaries carry the question. Escalating here too
    // would leave awaitingSubtasks armed through the lead's escalation run and
    // fire a duplicate "all subtasks finished" wake after it. Early escalation
    // is only for questions that would otherwise wait on running siblings.
    if (parent.subtasks.every((s) => isTerminalStatus(s.status))) return;
    const question = (task.error || '').trim() || 'no details provided';
    await this.followUp(
      task.parentId,
      `Your subtask «${task.title}» (id ${taskId}) is blocked and needs a decision before it can continue:\n\n` +
        `${question}\n\n` +
        `Handle it now — don't wait for your other subtasks: answer with follow_up on that subtask so it ` +
        `resumes, or adjust the plan. If you can't decide either, report yourself blocked with the question.`,
    );
    this.logger.log(`Task ${taskId} needs input — escalated to lead ${task.parentId}`);
  }

  private async wakeIfSubtasksDone(parentId: string): Promise<void> {
    const parent = await this.prisma.task.findUnique({
      where: { id: parentId },
      select: {
        status: true,
        awaitingSubtasks: true,
        subtasks: { select: { id: true, title: true, status: true } },
      },
    });
    if (!parent || !parent.awaitingSubtasks || !isTerminalStatus(parent.status)) return;
    if (!parent.subtasks.length || parent.subtasks.some((s) => !isTerminalStatus(s.status))) return;
    // Atomically claim the wake so overlapping child completions fire it once.
    const claimed = await this.prisma.task.updateMany({
      where: { id: parentId, awaitingSubtasks: true },
      data: { awaitingSubtasks: false },
    });
    if (claimed.count === 0) return;

    const lines = await Promise.all(
      parent.subtasks.map(async (s) => `- «${s.title}» → ${s.status}: ${await this.summarizeTask(s.id)}`),
    );
    const prompt =
      `All ${parent.subtasks.length} subtasks you created have finished:\n${lines.join('\n')}\n\n` +
      `Review their results and continue — integrate them, start the next phase, or report the task done.`;
    this.logger.log(`Task ${parentId}: subtasks complete — resuming lead`);
    await this.followUp(parentId, prompt);
  }

  /** A one-line result for a task: latest final answer, else reported summary, else title+status. */
  private async summarizeTask(id: string): Promise<string> {
    const result = await this.prisma.agentEvent.findFirst({
      where: { taskId: id, kind: 'result' },
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      select: { text: true },
    });
    if (result?.text?.trim()) return truncate(result.text.trim(), 500);
    const session = await this.prisma.agentSession.findFirst({
      where: { taskId: id, status: 'completed', reportedSummary: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { reportedSummary: true },
    });
    return session?.reportedSummary ?? '(no result)';
  }

  /**
   * Point `fromTaskId` at each referenced task (deduped, self-links skipped,
   * unknown ids ignored). Idempotent — re-linking an existing pair is a no-op.
   */
  async linkReferences(fromTaskId: string, toIds: string[]) {
    const unique = [...new Set(toIds)].filter((id) => id && id !== fromTaskId);
    if (!unique.length) return;
    const existing = await this.prisma.task.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    const valid = new Set(existing.map((t) => t.id));
    const skipped = unique.filter((id) => !valid.has(id));
    if (skipped.length) this.logger.warn(`Ignoring unknown referenced tasks: ${skipped.join(', ')}`);
    // fromTaskId is fixed here, so "already linked" reduces to a plain `in` on
    // toTaskId — no `skipDuplicates` needed (unsupported on SQLite anyway).
    const alreadyLinked = await this.prisma.taskLink.findMany({
      where: { fromTaskId, toTaskId: { in: unique } },
      select: { toTaskId: true },
    });
    const linkedIds = new Set(alreadyLinked.map((l) => l.toTaskId));
    const toLink = unique.filter((id) => valid.has(id) && !linkedIds.has(id));
    if (!toLink.length) return;
    await this.prisma.taskLink.createMany({
      data: toLink.map((toTaskId) => ({ fromTaskId, toTaskId })),
    });
  }

  /** Queue a task that was created with autostart=false (after its uploads). */
  async start(id: string, attachments?: string[]) {
    const task = await this.get(id);
    if (task.status !== 'queued') {
      throw new ConflictException(`Task ${id} is ${task.status}, cannot start`);
    }
    await this.queue.enqueue({ taskId: id, attachments });
    return task;
  }

  /** Queue a follow-up that continues the task's existing agent session. */
  async followUp(id: string, prompt: string, attachments?: string[], references?: string[]) {
    const task = await this.get(id);
    // Only follow up on a settled task; following up on one still queued/
    // running/awaiting-approval would race a duplicate job onto the same worktree.
    if (!isTerminalStatus(task.status)) {
      throw new ConflictException(
        `Task ${id} is ${task.status}; wait for it to finish before following up`,
      );
    }
    // References added in a message accumulate on the task and fold into context.
    if (references?.length) await this.linkReferences(id, references);
    await this.setStatus(id, 'queued');
    await this.queue.enqueue({ taskId: task.id, followUpPrompt: prompt, attachments });
    return this.get(id);
  }

  /**
   * Re-run a task to continue it (used when a human approves continuing after the
   * step limit). Unlike followUp this doesn't require a terminal status — the
   * task is in `needs_approval` when the continuation is approved.
   */
  async continueRun(id: string, prompt: string) {
    await this.setStatus(id, 'queued');
    await this.queue.enqueue({ taskId: id, followUpPrompt: prompt });
    return this.get(id);
  }

  /**
   * Schedule a delayed follow-up so an agent can "check back later" (e.g. poll
   * CI). The job fires after delayMs and re-runs the task with the given prompt;
   * the run that scheduled it has ended by then. Cancelled with the task.
   */
  async scheduleFollowUp(id: string, prompt: string, delaySeconds: number): Promise<void> {
    const delayMs = Math.min(Math.max(Math.round(delaySeconds), 30), 3600) * 1000; // 30s..1h
    await this.queue.enqueue({ taskId: id, followUpPrompt: prompt }, { delayMs });
    this.logger.log(`Scheduled follow-up for task ${id} in ${delayMs / 1000}s`);
  }

  /** Persist the worktree/branch assigned to a task. */
  async attachWorktree(id: string, branch: string, worktreePath: string) {
    return this.prisma.task.update({ where: { id }, data: { branch, worktreePath } });
  }

  /** Persist the PR opened for a task and notify listeners. */
  async attachPr(id: string, prUrl: string) {
    const task = await this.prisma.task.update({ where: { id }, data: { prUrl } });
    this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(task) } });
    return task;
  }

  /** Persist a direct-push target (branch/commit) — shared mode, no PR. */
  async attachPushedTo(id: string, pushedTo: string) {
    const task = await this.prisma.task.update({ where: { id }, data: { pushedTo } });
    this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(task) } });
    return task;
  }

  /**
   * Paginated + searchable task list. Without a query, one page is a slice of
   * top-level tasks (newest first) with all their subtasks pulled in, so the
   * grouped view stays whole within a page. With a query, we search across all
   * tasks (title/prompt, plus exact id) and return the matches flat.
   */
  async list(params: { q?: string; page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
    const q = params.q?.trim();
    const include = {
      _count: { select: { approvals: { where: { status: 'pending' } }, sessions: true } },
    } as const;

    // `mode: 'insensitive'` isn't supported on SQLite (Prisma rejects the
    // argument outright) — SQLite's own `contains`/LIKE is already ASCII
    // case-insensitive by default, so omitting it there is the equivalent
    // behavior for the common case, not a degraded one.
    const insensitive = this.config.storageDriver === 'postgres' ? ({ mode: 'insensitive' } as const) : {};
    const where = q
      ? {
          OR: [
            { title: { contains: q, ...insensitive } },
            { prompt: { contains: q, ...insensitive } },
            { id: q },
          ],
        }
      : { parentId: null };

    const [top, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include,
      }),
      this.prisma.task.count({ where }),
    ]);

    let items = top;
    if (!q && top.length) {
      const children = await this.prisma.task.findMany({
        where: { parentId: { in: top.map((t) => t.id) } },
        orderBy: { createdAt: 'asc' },
        include,
      });
      items = [...top, ...children];
    }
    return { items, total, page, pageSize };
  }

  async get(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: {
        sessions: { orderBy: { startedAt: 'asc' } },
        approvals: { orderBy: { createdAt: 'desc' } },
        parent: { select: { id: true, title: true, status: true } },
        subtasks: {
          select: { id: true, title: true, status: true, agentName: true },
          orderBy: { createdAt: 'asc' },
        },
        // Referenced tasks + the latest completed session summary, for context.
        linksOut: {
          include: {
            to: {
              select: {
                id: true,
                title: true,
                status: true,
                sessions: {
                  where: { status: 'completed', reportedSummary: { not: null } },
                  orderBy: { startedAt: 'desc' },
                  take: 1,
                  select: { reportedSummary: true },
                },
              },
            },
          },
        },
      },
    });
    if (!task) throw new NotFoundException(`Task ${id} not found`);
    return task;
  }

  /** Full ordered transcript for a task (all sessions' events). */
  async transcript(id: string) {
    await this.get(id); // existence check
    const events = await this.prisma.agentEvent.findMany({
      where: { taskId: id },
      orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
    });
    // Returned directly as the API response — attachments must be a plain
    // array regardless of storage driver (see agent-event-attachments.ts).
    return events.map((e) => ({ ...e, attachments: decodeAttachments(this.config, e.attachments) }));
  }

  /** Delete a task (cascades to sessions/events/approvals) and clean up its git artifacts. */
  async delete(id: string) {
    const task = await this.get(id); // 404 if missing
    // Stop any in-flight/queued work first so we don't tear the worktree out
    // from under a running agent.
    if (!isTerminalStatus(task.status)) {
      await this.queue.removeForTask(id).catch(() => undefined);
      this.executor.cancel(id);
    }
    await this.worktrees.cleanup(task.branch, task.worktreePath).catch(() => undefined);
    await this.attachments.remove(id).catch(() => undefined);
    await this.prisma.task.delete({ where: { id } });
    this.bus.publish({ type: 'task-deleted', payload: { taskId: id } });
    this.logger.log(`Deleted task ${id}`);
    return { id, deleted: true };
  }

  async cancel(id: string) {
    const task = await this.get(id);
    if (isTerminalStatus(task.status)) {
      return task; // already finished — nothing to cancel
    }
    // Drop any queued jobs and abort an in-flight run, then mark cancelled.
    await this.queue.removeForTask(id);
    const cancelled = await this.setStatus(id, 'cancelled');
    this.executor.cancel(id);
    return cancelled;
  }

  /**
   * Reconcile tasks left `running` by a previous process. A freshly-started
   * orchestrator has nothing actually executing, so any `running` row is an
   * orphan from a crash/restart — mark it `stalled` so it doesn't hang forever
   * (and can't masquerade as active work alongside a retry). Returns the count.
   */
  async reconcileOrphanedRunning(): Promise<number> {
    const orphans = await this.prisma.task.findMany({
      where: { status: 'running' },
      select: { id: true },
    });
    for (const { id } of orphans) {
      await this.setStatus(id, 'stalled', 'orphaned by an orchestrator restart — was left running');
    }
    if (orphans.length) this.logger.warn(`Reconciled ${orphans.length} orphaned running task(s) → stalled`);
    return orphans.length;
  }

  /** Persist a lifecycle transition. Used by the queue/agent layers. */
  async setStatus(id: string, status: TaskStatus, error?: string) {
    const task = await this.prisma.task.update({
      where: { id },
      data: { status, ...(error !== undefined ? { error } : {}) },
    });
    const ts = new Date().toISOString();
    this.bus.publish({ type: 'task-status', payload: { taskId: id, status, ts } });
    this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(task) } });
    return task;
  }
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0]?.trim() ?? 'Untitled task';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
