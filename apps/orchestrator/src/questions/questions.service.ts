import { Injectable, Logger, OnModuleInit, OnModuleDestroy, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import type { AgentQuestion, QuestionStatus } from '@lds/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AgentEventBus } from '../bus/agent-event-bus';
import { serializeTask } from '../tasks/tasks.service';
import { answerForModel, cleanQuestion, resolveAnswer } from './questions-core';

type Row = Awaited<ReturnType<PrismaService['agentQuestion']['create']>>;

export function serializeQuestion(row: Row): AgentQuestion {
  return {
    id: row.id,
    taskId: row.taskId,
    agentSessionId: row.agentSessionId,
    question: row.question,
    options: Array.isArray(row.options) ? (row.options as unknown[]).map(String) : [],
    allowText: row.allowText,
    multiple: row.multiple,
    image: row.image,
    status: row.status as QuestionStatus,
    answer: row.answer,
    answerIndex: row.answerIndex,
    answeredBy: row.answeredBy,
    createdAt: row.createdAt.toISOString(),
    answeredAt: row.answeredAt ? row.answeredAt.toISOString() : null,
  };
}

/** How long an agent waits for a human to answer (env QUESTION_TIMEOUT_SECONDS, default 1 h). */
const timeoutMs = (): number => Math.max(30, parseInt(process.env.QUESTION_TIMEOUT_SECONDS ?? '3600', 10) || 3600) * 1000;

/**
 * `ask_user`: an agent asks a human a question with answer buttons and waits. The question is a row (so a reload of the dashboard
 * or a restart of a chat still shows it) and an event (dashboard card, chat message with buttons); the first answer wins.
 * While it waits the task is `needs_approval`, like any other human step.
 */
@Injectable()
export class QuestionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuestionsService.name);
  private unsubscribe?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: AgentEventBus,
  ) {}

  onModuleInit(): void {
    // A task that was cancelled / ended takes its open questions with it (the waiting agent gets "cancelled", chat buttons go away).
    this.unsubscribe = this.bus.subscribe((e) => {
      if (e.type === 'task-status' && ['cancelled', 'failed', 'stalled', 'done', 'blocked'].includes(e.payload.status)) void this.cancelForTask(e.payload.taskId).catch(() => undefined);
      if (e.type === 'task-deleted') void this.cancelForTask(e.payload.taskId).catch(() => undefined);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** The tool handler: create the question, wait for the answer, return the text the model reads. */
  async ask(taskId: string, agentSessionId: string | undefined, input: { question: string; options: string[]; allowText: boolean; multiple?: boolean; image?: string }): Promise<string> {
    const clean = cleanQuestion(input);
    if (!clean) throw new Error('ask_user needs a question.');
    const allowText = clean.options.length === 0 ? true : input.allowText;
    const row = await this.prisma.agentQuestion.create({
      data: { taskId, agentSessionId: agentSessionId ?? null, question: clean.question, options: clean.options, allowText, multiple: Boolean(input.multiple) && clean.options.length > 1, image: input.image ?? null },
    });
    this.bus.publish({ type: 'question-created', payload: { question: serializeQuestion(row) } });
    await this.setTaskStatus(taskId, 'needs_approval');
    this.logger.log(`Question ${row.id} for task ${taskId}: ${clean.question.slice(0, 80)}`);
    const limit = timeoutMs();
    const done = await this.waitFor(row.id, limit);
    return answerForModel(done, Math.round(limit / 60000));
  }

  private waitFor(id: string, limit: number): Promise<Row> {
    return new Promise<Row>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        fn();
      };
      const recheck = (): void => {
        this.prisma.agentQuestion
          .findUnique({ where: { id } })
          .then((row) => {
            if (!row) finish(() => reject(new Error('The question was removed.')));
            else if (row.status !== 'pending') finish(() => resolve(row));
          })
          .catch((e) => finish(() => reject(e)));
      };
      const unsubscribe = this.bus.subscribe((e) => {
        if (e.type === 'question-resolved' && e.payload.question.id === id) recheck();
      });
      const timer = setTimeout(() => {
        this.close(id, 'timeout')
          .then(() => recheck())
          .catch((e) => finish(() => reject(e)));
      }, limit);
      recheck(); // the answer may already be in
    });
  }

  /** A person's answer — a tapped button (`index`) or typed text. The first answer wins. */
  async answer(id: string, input: { index?: number; indexes?: number[]; text?: string }, by?: { id?: string; displayName: string }): Promise<AgentQuestion> {
    const row = await this.getRow(id);
    if (row.status !== 'pending') throw new ConflictException(`Already ${row.status === 'answered' ? 'answered' : 'closed'}.`);
    const options = Array.isArray(row.options) ? (row.options as unknown[]).map(String) : [];
    const r = resolveAnswer(options, row.allowText, input, row.multiple);
    if ('error' in r) throw new BadRequestException(r.error);
    const updated = await this.prisma.agentQuestion.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'answered', answer: r.answer, answerIndex: r.index, answeredBy: by?.displayName?.trim() || 'human', answeredById: by?.id ?? null, answeredAt: new Date() },
    });
    if (updated.count === 0) throw new ConflictException('Already answered.');
    const done = await this.getRow(id);
    this.bus.publish({ type: 'question-resolved', payload: { question: serializeQuestion(done) } });
    this.logger.log(`Question ${id} answered by ${done.answeredBy}`);
    await this.resumeIfClear(done.taskId);
    return serializeQuestion(done);
  }

  /** Time out or withdraw a pending question. */
  async close(id: string, status: 'timeout' | 'cancelled'): Promise<void> {
    const r = await this.prisma.agentQuestion.updateMany({ where: { id, status: 'pending' }, data: { status, answeredAt: new Date() } });
    if (r.count === 0) return;
    const row = await this.getRow(id);
    this.bus.publish({ type: 'question-resolved', payload: { question: serializeQuestion(row) } });
    await this.resumeIfClear(row.taskId);
  }

  /** A task was cancelled / ended: its open questions are withdrawn (their chat buttons go away). */
  async cancelForTask(taskId: string): Promise<void> {
    const open = await this.prisma.agentQuestion.findMany({ where: { taskId, status: 'pending' }, select: { id: true } });
    for (const q of open) await this.close(q.id, 'cancelled');
  }

  async list(status?: QuestionStatus, taskId?: string): Promise<AgentQuestion[]> {
    const rows = await this.prisma.agentQuestion.findMany({
      where: { ...(status ? { status } : {}), ...(taskId ? { taskId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(serializeQuestion);
  }

  async get(id: string): Promise<AgentQuestion> {
    return serializeQuestion(await this.getRow(id));
  }

  /** The oldest open question of a task (a chat message from its owner answers it). */
  async pendingForTask(taskId: string): Promise<AgentQuestion | null> {
    const row = await this.prisma.agentQuestion.findFirst({ where: { taskId, status: 'pending' }, orderBy: { createdAt: 'asc' } });
    return row ? serializeQuestion(row) : null;
  }

  private async resumeIfClear(taskId: string): Promise<void> {
    const [q, a] = await Promise.all([
      this.prisma.agentQuestion.count({ where: { taskId, status: 'pending' } }),
      this.prisma.approvalRequest.count({ where: { taskId, status: 'pending' } }),
    ]);
    if (q + a > 0) return;
    await this.setTaskStatus(taskId, 'running', 'needs_approval');
  }

  /** Atomic, guarded flip (never resurrects a cancelled / finished task). */
  private async setTaskStatus(taskId: string, to: 'needs_approval' | 'running', from: 'running' | 'needs_approval' = to === 'needs_approval' ? 'running' : 'needs_approval'): Promise<void> {
    const flipped = await this.prisma.task.updateMany({ where: { id: taskId, status: from }, data: { status: to } });
    if (flipped.count === 0) return;
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return;
    this.bus.publish({ type: 'task-status', payload: { taskId, status: to, ts: new Date().toISOString() } });
    this.bus.publish({ type: 'task-upserted', payload: { task: serializeTask(task) } });
  }

  private async getRow(id: string): Promise<Row> {
    const row = await this.prisma.agentQuestion.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Question ${id} not found`);
    return row;
  }
}
