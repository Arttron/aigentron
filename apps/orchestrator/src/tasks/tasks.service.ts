import { ESCALATION_TAIL_MARK, FAN_IN_TAIL_MARK, subtaskBlock } from './subtask-report';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TERMINAL_TASK_STATUSES, isTerminalStatus, type PendingFollowUp, type Task, type TaskStatus } from '@lds/shared';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { getTaskLite, type TaskLite } from '../agent/task-lite';
import { decodeAttachments } from '../prisma/agent-event-attachments';
import { TaskQueue, type TaskJobData } from '../queue/queue.constants';
import { AgentEventBus } from '../bus/agent-event-bus';
import { WorktreeService } from '../worktrees/worktree.service';
import { AgentExecutor } from '../agent/agent-executor';
import { matchAgent } from '../channels/agent-match';
import { ModuleRef } from '@nestjs/core';
import { TitlesService } from '../titles/titles.service';
import { fallbackTitle, isWeakPrompt, titleStateFor } from '../titles/title-core';
import { TASK_TYPES, isTaskType, typeWhere } from './task-types';
import { isDoneMessage } from './done-intent';
import { REUSABLE_STATUSES, SUBTASK_OVER, isSameWork, subtaskCapError } from './subtask-dedupe';
import { STATUS_FILTERS, isStatusFilter, statusesOf } from './task-status-filter';
import { AgentRegistryService } from '../agent-registry/agent-registry.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { SettingsService } from '../settings/settings.service';
import { ProjectsService } from '../projects/projects.service';
import { projectLabel } from '../projects/project-labels';
import { DEFAULT_PROJECT_ID } from '../projects/project-core';
import type { CreateTaskDto } from './dto/create-task.dto';

/** Prisma row shape for a task (dates as Date). */
type TaskRow = Awaited<ReturnType<PrismaService['task']['create']>>;

/** Serialize a Prisma task row into the wire-facing shared Task shape. */
export function serializeTask(row: TaskRow & { project?: { slug: string; name: string } | null }): Task {
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
    projectId: row.projectId,
    // the relation when the caller loaded it, else the label cache (ProjectsService keeps it current)
    project: row.project ? { slug: row.project.slug, name: row.project.name } : projectLabel(row.projectId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `project: { select: … }` for queries whose rows are returned to a client (list / get). */
const PROJECT_SELECT = { select: { slug: true, name: true } } as const;

/** Input for a subtask created by a lead agent's decomposition tool. */
export interface SubtaskInput {
  title?: string;
  prompt: string;
  agentName?: string;
}

/** Cap on pending follow-ups per task — matches the old client-only queue's
 *  limit (FollowUpForm.tsx), now enforced server-side since any client can add. */
export const MAX_PENDING_FOLLOWUPS = 3;

/** How long delete() waits for a live run to leave the worktree after aborting it. */
const DELETE_SETTLE_WAIT_MS = 15_000;
/** How long the next job of a task waits for the previous run's tail (push / PR) to finish. */
const START_SETTLE_WAIT_MS = 60_000;

/** What the worker's guarded `→ running` transition found. */
export type RunEntry = 'started' | 'busy' | 'gone';

/** Prisma row shape for a pending follow-up. */
type PendingFollowUpRow = Awaited<ReturnType<PrismaService['pendingFollowUp']['create']>>;

function serializePendingFollowUp(row: PendingFollowUpRow): PendingFollowUp {
  return {
    id: row.id,
    taskId: row.taskId,
    text: row.text,
    attachments: JSON.parse(row.attachments || '[]'),
    references: JSON.parse(row.references || '[]'),
    createdAt: row.createdAt.toISOString(),
  };
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
    private readonly moduleRef: ModuleRef,
    private readonly titles: TitlesService,
    private readonly projects: ProjectsService,
  ) {}

  /** Statuses a person may accept as finished: the agent's result is waiting, or the run ended without one and the person is content anyway. */
  private static readonly ACCEPTABLE: readonly TaskStatus[] = ['review', 'blocked', 'stalled', 'failed'];

  /**
   * Runs the worker of THIS process has in flight (startRunning → runSettled). While a task is here, a
   * terminal status written by the worker does not drain its pending follow-ups — the next run would
   * start in the same worktree while this one still pushes / opens the PR, and the old `finally` would
   * then stop the new run's preview (X-Q-3). The drain happens in runSettled, once the worker is out.
   */
  private readonly runs = new Map<string, { settled: Promise<void>; resolve: () => void }>();

  /**
   * The person says the task is finished (button, `/done`, or "done" in a message): `done`. Only a person does this for a top-level task —
   * agents' runs end in `review`. Subtasks are finished by their lead, not here.
   */
  
  /** How many subtasks of a task are not over yet. */
  openSubtaskCount(id: string): Promise<number> {
    return this.prisma.task.count({ where: { parentId: id, status: { notIn: SUBTASK_OVER as never } } });
  }

  async markDone(id: string, opts: { cancelOpenSubtasks?: boolean } = {}): Promise<Task> {
    const task = await this.getLite(id);
    if (task.status === 'done') return serializeTask(await this.get(id));
    if (!TasksService.ACCEPTABLE.includes(task.status as TaskStatus)) {
      throw new ConflictException(
        isTerminalStatus(task.status as TaskStatus) ? `A ${task.status} task cannot be marked done — start it again with a message first.` : `The task is still ${task.status} — wait until the agent has finished.`,
      );
    }
    // A job still waiting for this task (a scheduled re-check, a continuation) must not resurrect it later.
    await this.queue.removeForTask(id).catch((err) => this.logger.warn(`could not drop queued jobs of ${id}: ${(err as Error).message}`));
    // Subtasks are left alone unless the person chose to cancel the open ones (accepting a lead does not accept its subtasks).
    if (opts.cancelOpenSubtasks) {
      const open = await this.prisma.task.findMany({ where: { parentId: id, status: { notIn: SUBTASK_OVER as never } }, select: { id: true } });
      for (const s of open) await this.cancel(s.id).catch((err) => this.logger.warn(`could not cancel subtask ${s.id}: ${(err as Error).message}`));
      if (open.length) this.logger.log(`Task ${id}: cancelled ${open.length} open subtask(s) on accept`);
    }
    await this.setStatus(id, 'done');
    this.logger.log(`Task ${id} accepted as done by a person`);
    return serializeTask(await this.get(id));
  }

  /** Name a task from its request right away (in the background) — unless the request says too little to name it from. */
  private nameSoon(task: { id: string; prompt: string; agentName: string | null; titleState?: string }, attachments?: string[]): void {
    if ((task.titleState ?? 'auto') !== 'auto' || isWeakPrompt(task.prompt)) return;
    void this.nameTask(task.id, { prompt: task.prompt, attachments, agent: task.agentName }).catch(() => undefined);
  }

  /** After the first answer: a task still named by its first line (a vague request) is named from the whole context. */
  private async nameAfterRun(id: string): Promise<void> {
    const row = await this.prisma.task.findUnique({ where: { id }, select: { titleState: true, prompt: true, agentName: true } });
    if (!row || row.titleState !== 'auto') return;
    const first = await this.prisma.agentEvent.findFirst({ where: { taskId: id, kind: 'result' }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }], select: { text: true } });
    const files = (await this.attachments.list(id).catch(() => [])).map((a) => a.name);
    await this.nameTask(id, { prompt: row.prompt, attachments: files, agent: row.agentName, answer: first?.text ?? null });
  }

  private async nameTask(id: string, ctx: { prompt: string; attachments?: string[]; agent?: string | null; answer?: string | null }): Promise<void> {
    const title = await this.titles.suggest(ctx);
    if (!title) return;
    // only a task that is still auto-named: a person's or creator's title is never overwritten, and a task is named once
    const r = await this.prisma.task.updateMany({ where: { id, titleState: 'auto' }, data: { title, titleState: 'generated' } });
    if (!r.count) return;
    const fresh = await this.prisma.task.findUnique({ where: { id } });
    if (fresh) this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(fresh) } });
  }

  /** `expert_codex` / `Expert-Codex` / a small typo → the real agent name; otherwise an error that lists the agents there are. */
  private async resolveAgentName(typed: string): Promise<string> {
    const list = await this.agents.list().catch(() => []);
    if (list.some((a) => a.name === typed)) return typed;
    const m = matchAgent(typed, list);
    // Spelling variants (case, - vs _) are accepted; a real typo is NOT guessed (it could land on a different agent) — it is suggested.
    if (m.kind === 'exact') return m.name;
    const names = list.map((a) => a.name).join(', ') || 'none';
    if (m.kind === 'fuzzy') throw new NotFoundException(`No agent named "${typed}" — did you mean "${m.name}"? Agents: ${names}.`);
    throw new NotFoundException(
      m.kind === 'ambiguous'
        ? `Agent "${typed}" could be ${m.names.join(' or ')} — use the exact name. Agents: ${names}.`
        : `No agent named "${typed}". Agents: ${names}.`,
    );
  }

  async create(dto: CreateTaskDto, createdById?: string, opts: { byAgent?: boolean } = {}) {
    // A subtask's parent must exist; reject a dangling parentId early. A subtask is in its parent's project
    // (create_subtask does not change the project); otherwise the given slug (archived → 400), else the default.
    const parent = dto.parentId ? await this.get(dto.parentId) : null;
    const project = parent ? await this.projects.getById(parent.projectId) : await this.projects.forNewTask(dto.project);
    const projectId = project.id;
    // Explicit agent 404s on a bad name; otherwise fall back to the project's
    // default lead, else the global one (e.g. pm), tolerating its absence.
    let agent = null;
    if (dto.agentName) {
      agent = await this.agents.get(await this.resolveAgentName(dto.agentName));
    } else {
      const def = await this.projects.defaultAgentFor(project);
      if (def) {
        agent = await this.agents.get(def).catch(() => null);
        if (!agent) {
          this.logger.warn(
            `Default agent "${def}" does not exist — the task will run without an agent definition. Pick an existing default in Settings or the project.`,
          );
        }
      }
    }
    // A title given by the creator (a schedule, a discussion, a lead's subtask) is final; otherwise it starts as the first line and a better one is
    // generated from the context once the task starts (and again after the first answer when the request was too vague to name it).
    const given = dto.title?.trim();
    const title = given || fallbackTitle(dto.prompt);

    const task = await this.prisma.task.create({
      data: {
        prompt: dto.prompt,
        title,
        titleState: titleStateFor({ given: Boolean(given), byAgent: opts.byAgent }),
        kind: (dto as { kind?: string }).kind === 'discussion' ? 'discussion' : 'task',
        status: 'queued',
        agentName: agent?.name ?? null,
        createdById: createdById ?? null,
        parentId: dto.parentId ?? null,
        projectId,
        createdByChannel: dto.createdByChannel ?? null,
        providerOverride: dto.provider?.trim() || null,
      },
    });
    this.logger.log(
      `Created task ${task.id} [agent=${agent?.name ?? 'default'}]` +
        (task.parentId ? ` [parent=${task.parentId}]` : '') +
        (projectId !== DEFAULT_PROJECT_ID ? ` [project=${projectLabel(projectId).slug}]` : '') +
        ` "${title}"`,
    );
    // Link referenced tasks so their summaries fold into this task's context.
    if (dto.references?.length) await this.linkReferences(task.id, dto.references);
    this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(task) } });
    // Defer queuing when the client will upload attachments first (avoids the
    // run reading the attachments dir before the files land); it then /start-s.
    if (dto.autostart !== false) {
      await this.enqueueRun({ taskId: task.id, attachments: dto.attachments }, task.agentName);
      this.nameSoon(task, dto.attachments);
    }
    return task;
  }

  /**
   * Create + enqueue a subtask under a parent. Used by a lead agent's
   * decomposition tool and by the API. Inherits the parent's referenced tasks
   * so a subtask sees the same related context.
   */
  async createSubtask(parentId: string, input: SubtaskInput, createdById?: string, opts: { fromAgent?: boolean } = {}) {
    const parent = await this.get(parentId); // 404 if missing
    // An AGENT must not multiply tasks: a cap per task, and a request for work that already exists (running, waiting for review or done) is
    // answered with that subtask instead of a new one.
    if (opts.fromAgent) {
      const existing = await this.prisma.task.findMany({ where: { parentId }, select: { id: true, title: true, prompt: true, status: true, agentName: true } });
      const limit = Math.max(1, parseInt(process.env.SUBTASK_LIMIT ?? '25', 10) || 25);
      const capError = subtaskCapError(existing.map((e) => e.status), limit);
      if (capError) throw new ConflictException(capError);
      const wanted = input.agentName ? await this.resolveAgentName(input.agentName).catch(() => input.agentName) : null;
      const same = existing.find((e) => (REUSABLE_STATUSES as readonly string[]).includes(e.status) && (e.agentName ?? null) === (wanted ?? null) && isSameWork(e.prompt, input.prompt));
      if (same) {
        this.logger.log(`Subtask request for ${parentId} reused ${same.id} (${same.status}) instead of creating a duplicate`);
        return { ...(await this.get(same.id)), reused: true as const };
      }
    }
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
      { byAgent: opts.fromAgent === true },
    );
    // Mark the parent so it's resumed with results once all subtasks finish.
    await this.prisma.task.update({ where: { id: parentId }, data: { awaitingSubtasks: true } });
    return child;
  }

  /**
   * A lead marks one of ITS subtasks done. The subtask must have finished its run: an agent's own subtask normally ends `done` by itself;
   * this accepts one that ended `review`, `blocked`, `stalled` or `failed` (the lead dealt with it, or no longer needs it).
   */
  async completeSubtask(parentId: string, subtaskId: string): Promise<string> {
    const id = subtaskId.trim();
    const sub = await this.prisma.task.findUnique({ where: { id }, select: { id: true, title: true, status: true, parentId: true } });
    if (!sub || sub.parentId !== parentId) return `No subtask ${id} of this task. Use check_subtasks to see the ids.`;
    if (sub.status === 'done') return `Subtask ${id} «${sub.title}» is already done.`;
    if (sub.status === 'cancelled') return `Subtask ${id} was cancelled — it cannot be marked done.`;
    if (!isTerminalStatus(sub.status as TaskStatus)) return `Subtask ${id} is still ${sub.status} — wait until it has finished (check_subtasks).`;
    await this.setStatus(id, 'done');
    this.logger.log(`Subtask ${id} marked done by its lead ${parentId}`);
    return `Subtask ${id} «${sub.title}» marked done (it was ${sub.status}).`;
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
        summary: (await this.summarizeTask(s.id)) + (await this.subtaskFilesNote(s.id)),
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
      `A subtask you created is blocked and needs a decision before it can continue:\n\n` +
        `${subtaskBlock({ id: taskId, title: task.title, status: 'blocked', body: question })}\n\n` +
        `${ESCALATION_TAIL_MARK} — don't wait for your other subtasks: answer with follow_up on that subtask so it ` +
        `resumes, or adjust the plan. If you can't decide either, report yourself blocked with the question.`,
    );
    this.logger.log(`Task ${taskId} needs input — escalated to lead ${task.parentId}`);
  }

  /**
   * Take a subtask out of its lead and make it a top-level task of the same project (it grew too big for a part: it now gets its own
   * subtasks, review and accept). Its history, files and agent stay; a reference to the former lead keeps the context. Only a settled
   * subtask can move — a running one is settled by the rules of a subtask (it ends `done`, not "ready — confirm").
   */
  async promoteToRoot(id: string): Promise<Task> {
    const task = await this.getLite(id);
    if (!task.parentId) throw new ConflictException('This task is already a top-level task.');
    if (!isTerminalStatus(task.status as TaskStatus)) {
      throw new ConflictException(`The subtask is still ${task.status} — let it finish (or cancel it) before moving it to the top level.`);
    }
    const parentId = task.parentId;
    await this.prisma.task.update({ where: { id }, data: { parentId: null } });
    await this.linkReferences(id, [parentId]);
    this.logger.log(`Subtask ${id} moved out of ${parentId} to the top level`);
    // The lead may have been waiting only for this one.
    await this.wakeIfSubtasksDone(parentId).catch((err) => this.logger.warn(`could not re-check the lead ${parentId}: ${(err as Error).message}`));
    const fresh = serializeTask(await this.get(id));
    this.bus.publish({ type: 'task-upserted', payload: { task: fresh } });
    const parent = await this.prisma.task.findUnique({ where: { id: parentId } });
    if (parent) this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(parent) } });
    return fresh;
  }

  /** If this lead is waiting for its subtasks and every one of them is over, resume it with their results. Safe to call any time. */
  async wakeIfSubtasksDone(parentId: string): Promise<void> {
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

    // one block per subtask (subtask-report.ts): the conversation shows each as a message from that subtask's agent
    const blocks = await Promise.all(
      parent.subtasks.map(async (s) => subtaskBlock({ id: s.id, title: s.title, status: s.status, body: `${await this.summarizeTask(s.id)}${await this.subtaskFilesNote(s.id)}` })),
    );
    const prompt =
      `All ${parent.subtasks.length} subtasks you created have finished:\n\n${blocks.join('\n\n')}\n\n` +
      `${FAN_IN_TAIL_MARK} — integrate them, start the next phase, or report the task done. Write your own result: do not quote or retell the subtasks' answers, and do not copy or re-attach their files — the person sees them already.`;
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
    if (result?.text?.trim()) {
      // A lead builds on what its subtasks found (a designer's whole report, a review's findings), so this is generous; a cut is marked, never silent.
      const full = result.text.trim();
      return full.length > SUBTASK_RESULT_CHARS
        ? `${full.slice(0, SUBTASK_RESULT_CHARS)}\n[… cut: ${full.length - SUBTASK_RESULT_CHARS} more characters in the subtask's own transcript; ask its agent to put the rest in a file or a shorter report]`
        : full;
    }
    const session = await this.prisma.agentSession.findFirst({
      where: { taskId: id, status: 'completed', reportedSummary: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { reportedSummary: true },
    });
    return session?.reportedSummary ?? '(no result)';
  }

  /**
   * The files a subtask produced, as one line for its lead: name, and how to show them WITHOUT copying (a reference to the subtask's own file).
   * Empty when it has none. The lead mentions them or shows them; it does not quote them or re-attach them.
   */
  private async subtaskFilesNote(id: string): Promise<string> {
    const files = (await this.attachments.list(id).catch(() => [])).filter((f) => !f.name.startsWith('.')).slice(0, 12);
    if (!files.length) return '';
    return `\n  files: ${files.map((f) => `${f.name} (task:${id}/${f.name})`).join(', ')} — show a picture with show_images or ![caption](task:${id}/file.png); name other files; never copy or re-attach them`;
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

  /** Queue a run; a turn of a chat-mode agent (the admin) goes to the reserved lane, outside the cap the task runs share. */
  private async enqueueRun(data: TaskJobData, agentName: string | null | undefined, opts?: { delayMs?: number }): Promise<void> {
    const agent = agentName ? await this.agents.get(agentName).catch(() => null) : null;
    await this.queue.enqueue(agent?.mode === 'chat' ? { ...data, lane: 'chat' } : data, opts);
  }

  /** Queue a task that was created with autostart=false (after its uploads). */
  async start(id: string, attachments?: string[]) {
    const task = await this.get(id);
    if (task.status !== 'queued') {
      throw new ConflictException(`Task ${id} is ${task.status}, cannot start`);
    }
    await this.enqueueRun({ taskId: id, attachments }, task.agentName);
    this.nameSoon(task, attachments);
    return task;
  }

  /**
   * Continue a task with a follow-up message. If it's still running (not
   * terminal), the message is held in the server-side pending-follow-up queue
   * instead of racing a duplicate job onto the same worktree — the SAME queue
   * whether this came from the dashboard or a channel, drained (oldest first,
   * one per settle cycle) by setStatus() whenever the task next goes terminal.
   * Returns the task detail with `queued`/`queueLength` merged in so a caller
   * that doesn't care can still treat the result as a plain task.
   */
  async followUp(id: string, prompt: string, attachments?: string[], references?: string[]) {
    const task = await this.getLite(id);
    // "Done" / "готово" / "задача завершена" — the person closes the task; nothing is sent to the agent.
    if (isDoneMessage(prompt) && !attachments?.length && TasksService.ACCEPTABLE.includes(task.status as TaskStatus)) {
      await this.markDone(id);
      return { ...(await this.get(id)), queued: false as const, queueLength: 0 };
    }
    // While agents discuss in this chat, the person's message joins the discussion (answered at the next turn) instead of queueing a run.
    const { DiscussionService } = await import('../discussion/discussion.service');
    const discussion = this.moduleRef.get(DiscussionService, { strict: false });
    if (discussion?.isActive(id)) {
      await discussion.interject(id, prompt);
      return { ...(await this.get(id)), queued: false as const, queueLength: 0 };
    }
    if (!isTerminalStatus(task.status)) {
      return this.enqueueFollowUp(id, prompt, attachments, references);
    }
    return this.runFollowUpNow(id, prompt, attachments, references);
  }

  /**
   * Dispatch a follow-up now. The task is claimed ATOMICALLY (terminal → queued): of two follow-ups that
   * arrive at once only one gets a job, the other is held in the pending queue and runs after it (X-Q-1).
   * The caller has seen the task terminal, but that read is not a lock.
   */
  private async runFollowUpNow(id: string, prompt: string, attachments?: string[], references?: string[]) {
    // References added in a message accumulate on the task and fold into context.
    if (references?.length) await this.linkReferences(id, references);
    const claimed = await this.prisma.task.updateMany({
      where: { id, status: { in: [...TERMINAL_TASK_STATUSES] } },
      data: { status: 'queued' },
    });
    if (claimed.count === 0) {
      // Someone else just restarted it (or it is gone): hold the message for the next settle instead of a second run.
      this.logger.log(`Task ${id}: a run was just queued by another follow-up — holding this one`);
      return this.enqueueFollowUp(id, prompt, attachments);
    }
    this.publishStatus(id, 'queued');
    await this.enqueueRun({ taskId: id, followUpPrompt: prompt, attachments }, (await this.getLite(id)).agentName);
    const queueLength = await this.prisma.pendingFollowUp.count({ where: { taskId: id } });
    return { ...(await this.get(id)), queued: false as const, queueLength };
  }

  /**
   * Hold a follow-up for the next settle (the worker uses this for a job — a scheduled re-check, a late
   * continuation — that found another run of the task live). A full queue drops it with a warning rather
   * than failing the job: the running agent will settle and the person can resend.
   */
  async holdFollowUp(id: string, prompt: string, attachments?: string[]): Promise<void> {
    await this.enqueueFollowUp(id, prompt, attachments).catch((err) => {
      this.logger.warn(`Task ${id}: could not hold a follow-up for after the current run: ${(err as Error).message}`);
    });
  }

  private async enqueueFollowUp(id: string, prompt: string, attachments?: string[], references?: string[]) {
    const count = await this.prisma.pendingFollowUp.count({ where: { taskId: id } });
    if (count >= MAX_PENDING_FOLLOWUPS) {
      throw new ConflictException(
        `Follow-up queue is full (${MAX_PENDING_FOLLOWUPS}) for this task — remove one before adding another`,
      );
    }
    await this.prisma.pendingFollowUp.create({
      data: {
        taskId: id,
        text: prompt,
        attachments: JSON.stringify(attachments ?? []),
        references: JSON.stringify(references ?? []),
      },
    });
    await this.publishFollowUpQueue(id);
    return { ...(await this.get(id)), queued: true as const, queueLength: count + 1 };
  }

  /** Pop the oldest pending follow-up (if any) and run it now — called whenever a task settles into a
   *  terminal status (setStatus outside a run; runSettled for the worker's own runs). */
  private async drainPendingFollowUp(id: string): Promise<void> {
    const next = await this.prisma.pendingFollowUp.findFirst({
      where: { taskId: id },
      orderBy: { createdAt: 'asc' },
    });
    if (!next) return;
    // Delete before dispatch: runFollowUpNow flips the task off-terminal, and a
    // concurrent read of the queue mid-dispatch should already see it gone.
    await this.prisma.pendingFollowUp.delete({ where: { id: next.id } }).catch(() => undefined);
    await this.publishFollowUpQueue(id);
    await this.runFollowUpNow(
      id,
      next.text,
      JSON.parse(next.attachments || '[]'),
      JSON.parse(next.references || '[]'),
    );
  }

  async listPendingFollowUps(taskId: string): Promise<PendingFollowUp[]> {
    const rows = await this.prisma.pendingFollowUp.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(serializePendingFollowUp);
  }

  /** Remove one queued follow-up (e.g. the dashboard's ✕ button). Scoped by
   *  taskId too so a stray id from elsewhere can't touch another task's queue. */
  async removePendingFollowUp(taskId: string, pendingId: string): Promise<PendingFollowUp[]> {
    await this.prisma.pendingFollowUp.deleteMany({ where: { id: pendingId, taskId } });
    await this.publishFollowUpQueue(taskId);
    return this.listPendingFollowUps(taskId);
  }

  /** Edit a queued follow-up in place (the dashboard's ✎ edit flow) — only the
   *  provided fields change, so a text-only edit doesn't disturb attachments. */
  async updatePendingFollowUp(
    taskId: string,
    pendingId: string,
    patch: { text?: string; attachments?: string[]; references?: string[] },
  ): Promise<PendingFollowUp[]> {
    const data: { text?: string; attachments?: string; references?: string } = {};
    if (patch.text !== undefined) data.text = patch.text;
    if (patch.attachments !== undefined) data.attachments = JSON.stringify(patch.attachments);
    if (patch.references !== undefined) data.references = JSON.stringify(patch.references);
    await this.prisma.pendingFollowUp.updateMany({ where: { id: pendingId, taskId }, data });
    await this.publishFollowUpQueue(taskId);
    return this.listPendingFollowUps(taskId);
  }

  private async publishFollowUpQueue(taskId: string): Promise<void> {
    const queue = await this.listPendingFollowUps(taskId);
    this.bus.publish({ type: 'followup-queue', payload: { taskId, queue } });
  }

  /**
   * Re-run a task to continue it (used when a human approves continuing after the
   * step limit). Unlike followUp this doesn't require a terminal status — the
   * task is in `needs_approval` when the continuation is approved.
   */
  async continueRun(id: string, prompt: string) {
    // Guarded: only a task waiting for that approval (or the worker's own hand-back of a still-running one)
    // is re-queued. A continuation approved after the task was cancelled or finished must not revive it (X-Q-5).
    const claimed = await this.prisma.task.updateMany({
      where: { id, status: { in: ['needs_approval', 'running'] } },
      data: { status: 'queued' },
    });
    if (claimed.count === 0) {
      this.logger.warn(`Task ${id}: continuation ignored — the task is no longer waiting for it`);
      return this.get(id);
    }
    this.publishStatus(id, 'queued');
    await this.enqueueRun({ taskId: id, followUpPrompt: prompt }, (await this.getLite(id)).agentName);
    return this.get(id);
  }

  /**
   * Schedule a delayed follow-up so an agent can "check back later" (e.g. poll
   * CI). The job fires after delayMs and re-runs the task with the given prompt;
   * the run that scheduled it has ended by then. Cancelled with the task.
   */
  async scheduleFollowUp(id: string, prompt: string, delaySeconds: number): Promise<void> {
    const delayMs = Math.min(Math.max(Math.round(delaySeconds), 30), 3600) * 1000; // 30s..1h
    await this.enqueueRun({ taskId: id, followUpPrompt: prompt }, (await this.getLite(id)).agentName, { delayMs });
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
  /** Names of conversational agents (mode: chat) — they define the "chat" task type. */
  private async chatAgentNames(): Promise<string[]> {
    return (await this.agents.list().catch(() => [])).filter((a) => a.mode === 'chat').map((a) => a.name);
  }

  /** How many tasks of each type there are (the numbers on the filter chips). */
  /** `{ projectId }` for a project slug (an unknown slug matches nothing rather than everything), or null for "every project". */
  private async projectWhere(slug?: string): Promise<{ projectId: string } | null> {
    const s = slug?.trim();
    return s ? { projectId: (await this.projects.get(s).catch(() => null))?.id ?? '' } : null;
  }

  async typeCounts(project?: string): Promise<Record<string, number> & { all: number }> {
    const chat = await this.chatAgentNames();
    const inProject = await this.projectWhere(project);
    const counts = await Promise.all(TASK_TYPES.map((tp) => this.prisma.task.count({ where: (inProject ? { AND: [typeWhere(tp, chat), inProject] } : typeWhere(tp, chat)) as never })));
    const out: Record<string, number> = {};
    TASK_TYPES.forEach((tp, i) => (out[tp] = counts[i]!));
    return { ...out, all: counts.reduce((a, b) => a + b, 0) } as Record<string, number> & { all: number };
  }

  /** How many tasks are in each status (and the two groups) — the numbers on the status chips. Optionally within one type. */
  async statusCounts(type?: string, project?: string): Promise<Record<string, number>> {
    const inProject = await this.projectWhere(project);
    const out: Record<string, number> = {};
    if (!isTaskType(type)) {
      // the numbers of the list below: top-level tasks whose own status, or a subtask's, is in the group (see `list`)
      await Promise.all(
        STATUS_FILTERS.map(async (f) => {
          const inStatus = { in: statusesOf(f) };
          const where = { AND: [{ parentId: null }, { OR: [{ status: inStatus }, { subtasks: { some: { status: inStatus } } }] }, ...(inProject ? [inProject] : [])] };
          out[f] = await this.prisma.task.count({ where: where as never });
        }),
      );
      return out;
    }
    const typed = typeWhere(type, await this.chatAgentNames());
    const rows = await this.prisma.task.groupBy({ by: ['status'], where: (inProject ? { AND: [typed, inProject] } : typed) as never, _count: { _all: true } });
    const by: Record<string, number> = {};
    for (const r of rows) by[r.status] = r._count._all;
    for (const f of STATUS_FILTERS) out[f] = statusesOf(f).reduce((n, s) => n + (by[s] ?? 0), 0);
    return out;
  }

  async list(params: { q?: string; type?: string; status?: string; project?: string; page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
    const q = params.q?.trim();
    const include = {
      _count: { select: { approvals: { where: { status: 'pending' } }, sessions: true } },
      project: PROJECT_SELECT,
    } as const;
    // A project filter (by slug): an unknown slug lists nothing rather than everything.
    const byProject = await this.projectWhere(params.project);

    // `mode: 'insensitive'` isn't supported on SQLite (Prisma rejects the
    // argument outright) — SQLite's own `contains`/LIKE is already ASCII
    // case-insensitive by default, so omitting it there is the equivalent
    // behavior for the common case, not a degraded one.
    const insensitive = this.config.storageDriver === 'postgres' ? ({ mode: 'insensitive' } as const) : {};
    const type = isTaskType(params.type) ? params.type : null;
    const typed = type ? typeWhere(type, await this.chatAgentNames()) : null;
    // SQLite's LIKE only ignores case for ASCII: for other scripts (Cyrillic, Greek, accents …) try the usual spellings of the query as well
    const spellings = this.config.storageDriver === 'postgres' || !q || !/[^\p{ASCII}]/u.test(q) ? [q ?? ''] : [...new Set([q, q.toLowerCase(), q.toUpperCase(), q.charAt(0).toUpperCase() + q.slice(1).toLowerCase()])];
    const search = {
      OR: [...spellings.flatMap((s) => [{ title: { contains: s, ...insensitive } }, { prompt: { contains: s, ...insensitive } }]), { id: q ?? '' }],
    };
    // A type filter or a search decides the shape itself (they look at every level and list flat: subtasks are found by what they say); without them
    // the list is the top-level tasks — also under a status filter.
    const status = isStatusFilter(params.status) ? params.status : null;
    const flat = Boolean(typed || q);
    const inStatus = status ? { in: statusesOf(status) } : null;
    // Flat: the task's own status. Top-level: the task's own status OR that of one of its subtasks — a blocked subtask under a finished parent is found
    // through its parent, and the row (which carries the subtask counts) shows where it is, instead of listing the subtask by itself.
    const byStatus = inStatus ? (flat ? { status: inStatus } : { OR: [{ status: inStatus }, { subtasks: { some: { status: inStatus } } }] }) : null;
    // The project filter narrows whichever shape the other filters chose.
    const parts = [typed, byStatus, q ? search : null].filter(Boolean);
    const shape = flat ? (parts.length === 1 ? parts[0] : { AND: parts }) : { AND: [{ parentId: null }, ...(byStatus ? [byStatus] : [])] };
    const where = (byProject ? { AND: [shape, byProject] } : shape) as never;

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

    // The list shows the tasks themselves, never their subtasks: each task carries how many it has and in which states
    // (a row says "5 subtasks · 3 done · 1 stalled"; the subtasks are on the task's own page).
    const subtasks = new Map<string, { total: number; byStatus: Record<string, number> }>();
    if (top.length) {
      const rows = await this.prisma.task.groupBy({ by: ['parentId', 'status'], where: { parentId: { in: top.map((t) => t.id) } }, _count: { _all: true }, orderBy: { parentId: 'asc' } });
      for (const r of rows) {
        if (!r.parentId) continue;
        const cur = subtasks.get(r.parentId) ?? { total: 0, byStatus: {} };
        cur.total += r._count._all;
        cur.byStatus[r.status] = (cur.byStatus[r.status] ?? 0) + r._count._all;
        subtasks.set(r.parentId, cur);
      }
    }
    const items = top.map((t) => ({ ...t, subtasks: subtasks.get(t.id) ?? { total: 0, byStatus: {} } }));
    return { items, total, page, pageSize };
  }

  /** Narrow read for code that only needs status / ids / worktree (E-09): no sessions, approvals, links. 404 like `get`. */
  async getLite(id: string): Promise<Omit<TaskLite, 'status'> & { status: TaskStatus }> {
    const task = await getTaskLite(this.prisma, id);
    if (!task) throw new NotFoundException(`Task ${id} not found`);
    return task as Omit<TaskLite, 'status'> & { status: TaskStatus };
  }

  async get(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: {
        project: PROJECT_SELECT,
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

  /** Delete a task (cascades to sessions/events/approvals/questions/jobs) and clean up its git artifacts. */
  async delete(id: string) {
    const task = await this.get(id); // 404 if missing
    // Stop any in-flight/queued work first so we don't tear the worktree out
    // from under a running agent. Always — a finished task may still own a
    // delayed job (schedule_check), which would otherwise run on a deleted row.
    await this.queue.removeForTask(id).catch((err) => this.logger.warn(`could not drop queued jobs of ${id}: ${(err as Error).message}`));
    // A live task is cancelled first (its pending follow-ups go with it), so the worker sees `cancelled`
    // and writes nothing more; then wait for the run to actually leave the worktree before removing it (E-23).
    if (!isTerminalStatus(task.status)) await this.cancel(id);
    this.executor.cancel(id);
    if (!(await this.awaitRunEnd(id, DELETE_SETTLE_WAIT_MS))) {
      this.logger.warn(`Task ${id}: its run did not end within ${DELETE_SETTLE_WAIT_MS / 1000}s — deleting anyway`);
    }
    await this.worktrees.cleanup(task.branch, task.worktreePath).catch(() => undefined);
    await this.attachments.remove(id).catch(() => undefined);
    await this.prisma.task.delete({ where: { id } });
    this.bus.publish({ type: 'task-deleted', payload: { taskId: id } });
    this.logger.log(`Deleted task ${id}`);
    return { id, deleted: true };
  }

  /**
   * Cancel a task. The ORDER matters:
   *  1. drop the pending follow-ups — `setStatus('cancelled')` is terminal and
   *     would otherwise drain one into a brand-new run (queued → running) of a
   *     task the person just stopped;
   *  2. drop the queued/delayed jobs, so nothing picks the task up again;
   *  3. mark it cancelled (the worker's guarded `running` transition refuses a
   *     job that slipped through between 2 and 3);
   *  4. abort the in-flight run last — its worker then sees `cancelled` and
   *     leaves the status alone instead of writing `stalled` over it.
   */
  async cancel(id: string) {
    const task = await this.getLite(id);
    if (isTerminalStatus(task.status)) {
      return this.get(id); // already finished — nothing to cancel
    }
    const dropped = await this.prisma.pendingFollowUp.deleteMany({ where: { taskId: id } });
    if (dropped.count) {
      this.logger.log(`Task ${id}: dropped ${dropped.count} pending follow-up(s) on cancel`);
      await this.publishFollowUpQueue(id).catch(() => undefined);
    }
    await this.queue.removeForTask(id);
    const cancelled = await this.setStatus(id, 'cancelled');
    this.executor.cancel(id);
    return cancelled ?? (await this.get(id));
  }

  /**
   * The worker's entry transition: `→ running`, but only for a task that is not
   * already finished by a person (`done`) or cancelled — a job that outlived its
   * task (a delayed re-check, a job claimed in the cancel window) must not
   * resurrect it (`gone`) — and not for one whose run is live or paused on an
   * approval: two runs of one task would share a worktree and abort each other
   * (`busy`, X-Q-1; the worker holds a follow-up for later). Only `started`
   * changes anything; the run is then tracked until runSettled().
   */
  async startRunning(id: string): Promise<RunEntry> {
    // The previous run of this task may still be in its tail (status written, PR being opened) when its
    // next job arrives — a hand-back or a follow-up sent the moment it settled. Let it leave the worktree first.
    if (!(await this.awaitRunEnd(id, START_SETTLE_WAIT_MS))) {
      this.logger.warn(`Task ${id}: the previous run is still finishing after ${START_SETTLE_WAIT_MS / 1000}s — starting the next one anyway`);
    }
    const r = await this.prisma.task.updateMany({
      where: { id, status: { notIn: ['cancelled', 'done', 'running', 'needs_approval'] } },
      data: { status: 'running' },
    });
    if (r.count === 0) {
      const row = await this.prisma.task.findUnique({ where: { id }, select: { status: true } });
      return row && (row.status === 'running' || row.status === 'needs_approval') ? 'busy' : 'gone';
    }
    let resolve!: () => void;
    const settled = new Promise<void>((res) => (resolve = res));
    this.runs.get(id)?.resolve();
    this.runs.set(id, { settled, resolve });
    this.publishStatus(id, 'running');
    return 'started';
  }

  /** Whether this process's worker has a run of the task in flight. */
  isRunning(id: string): boolean {
    return this.runs.has(id);
  }

  /**
   * The worker is fully out of the task (status written, preview stopped, PR opened): untrack the run
   * and, if the task settled, start the next held follow-up — the drain deferred by setStatus (X-Q-3).
   */
  async runSettled(id: string): Promise<void> {
    const run = this.runs.get(id);
    this.runs.delete(id);
    run?.resolve();
    const row = await this.prisma.task.findUnique({ where: { id }, select: { status: true } });
    if (row && isTerminalStatus(row.status as TaskStatus)) {
      await this.drainPendingFollowUp(id).catch((err) =>
        this.logger.warn(`drain pending follow-up failed for ${id}: ${(err as Error).message}`),
      );
    }
  }

  /** Wait (bounded) for a live run of the task in this process to end; false when it is still going. */
  private async awaitRunEnd(id: string, timeoutMs: number): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run) return true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([run.settled, new Promise<void>((res) => (timer = setTimeout(res, timeoutMs)))]);
    if (timer) clearTimeout(timer);
    return this.runs.get(id) !== run;
  }

  /** Fan the current row out to listeners after a status change. */
  private publishStatus(id: string, status: TaskStatus, task?: TaskRow | null): void {
    this.bus.publish({ type: 'task-status', payload: { taskId: id, status, ts: new Date().toISOString() } });
    if (task) {
      this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(task) } });
      return;
    }
    void this.prisma.task
      .findUnique({ where: { id } })
      .then((row) => row && this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(row) } }))
      .catch(() => undefined);
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

  /** `queued` tasks last touched before `cutoff`, with how many agent runs each has had (for the queue-vs-status reconcile). */
  async queuedTasksBefore(cutoff: Date): Promise<{ id: string; agentName: string | null; sessions: number }[]> {
    const rows = await this.prisma.task.findMany({ where: { status: 'queued', updatedAt: { lt: cutoff } }, select: { id: true, agentName: true, _count: { select: { sessions: true } } } });
    return rows.map((r) => ({ id: r.id, agentName: r.agentName, sessions: r._count.sessions }));
  }

  /** Queue a task again from scratch (its first run was lost with the queue). */
  async requeue(id: string, agentName: string | null): Promise<void> {
    await this.enqueueRun({ taskId: id }, agentName);
  }

  /**
   * Persist a lifecycle transition. Used by the queue/agent layers. Returns the row, or null when nothing
   * changed: the task is gone (deleted during its run — not an error, E-23), or the transition is refused —
   * `needs_approval` is only written over a live run (`running`/`queued`), never over a task that was
   * cancelled or finished while the approval hook was still asking (E-35).
   */
  async setStatus(id: string, status: TaskStatus, error?: string) {
    const guard = status === 'needs_approval' ? { status: { in: ['running', 'queued', 'needs_approval'] as TaskStatus[] } } : {};
    const r = await this.prisma.task.updateMany({
      where: { id, ...guard },
      data: { status, ...(error !== undefined ? { error } : {}) },
    });
    if (r.count === 0) {
      this.logger.warn(`Task ${id}: status ${status} not written — the task is gone or no longer in a state that allows it`);
      return null;
    }
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) return null;
    this.publishStatus(id, status, task);
    if (status === 'review' || status === 'done') void this.nameAfterRun(id).catch(() => undefined);
    // The task just settled — drain one pending follow-up if the queue has any (`queued` is NOT terminal,
    // so a dispatch doesn't recurse). While the worker is still inside the run the drain is deferred to
    // runSettled() (see `runs`). Never let a drain failure mask the status change itself.
    if (isTerminalStatus(status) && !this.runs.has(id)) {
      await this.drainPendingFollowUp(id).catch((err) =>
        this.logger.warn(`drain pending follow-up failed for ${id}: ${(err as Error).message}`),
      );
    }
    return task;
  }
}

/** How much of a subtask's final answer its lead is handed (fan-in and check_subtasks). */
const SUBTASK_RESULT_CHARS = 4000;
