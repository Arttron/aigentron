import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { ChannelsService } from '../channels/channels.service';
import { ChannelManagerService } from '../channels/channel-manager.service';
import { AgentRegistryService } from '../agent-registry/agent-registry.service';
import { describeSchedule, inQuietHours, isHM, isValidScheduleName, nextRun, validateCron } from './schedule-core';

type ScheduleRow = NonNullable<Awaited<ReturnType<PrismaService['schedule']['findUnique']>>>;

export interface ScheduleInput {
  name?: string;
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  kind?: string;
  text?: string;
  agentName?: string | null;
  /** task kind: `same` (default) = each run continues one task; `new` = each run starts a new task */
  taskMode?: string;
  channelId?: string | null;
  chatId?: string | null;
  quietStart?: string | null;
  quietEnd?: string | null;
}

const TICK_MS = 30_000;
/** In "same" mode a schedule's task is replaced by a fresh one after this long (keeps the conversation's context from growing without limit). */
const ROLLOVER_MS = 30 * 24 * 3600_000;
/** A run that is overdue by more than this (the server was off) is skipped rather than fired late. */
const GRACE_MS = 2 * 3600_000;

/** Wire shape: the row plus a human description of when it runs. */
export function serializeSchedule(r: ScheduleRow) {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    cron: r.cron,
    timezone: r.timezone,
    when: describeSchedule(r.cron, r.timezone),
    kind: r.kind,
    text: r.text,
    agentName: r.agentName,
    taskMode: r.taskMode,
    taskId: r.taskId,
    channelId: r.channelId,
    chatId: r.chatId,
    quietStart: r.quietStart,
    quietEnd: r.quietEnd,
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
  };
}

/**
 * Recurring jobs. Two kinds: `message` posts text to a chat (no model, free) and `task` starts a task for an agent
 * (its updates flow to the chat). The next run time lives in the database, so a restart loses nothing; a run missed
 * while the server was off is skipped instead of fired hours late.
 */
@Injectable()
export class SchedulesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulesService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly channels: ChannelsService,
    private readonly manager: ChannelManagerService,
    private readonly agents: AgentRegistryService,
  ) {}

  onModuleInit(): void {
    if (process.env.SCHEDULER_DISABLED === 'true') return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.warn(`tick failed: ${(e as Error).message}`)), TICK_MS);
    this.timer.unref?.();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async list(): Promise<ScheduleRow[]> {
    return this.prisma.schedule.findMany({ orderBy: { name: 'asc' } });
  }

  async get(id: string): Promise<ScheduleRow> {
    const r = await this.prisma.schedule.findUnique({ where: { id } });
    if (!r) throw new NotFoundException(`Schedule not found: ${id}`);
    return r;
  }

  /** Why this input is unusable (null = fine). `current` fills in fields an update leaves out. */
  async validate(input: ScheduleInput, current?: ScheduleRow): Promise<string | null> {
    const v = { ...(current ?? {}), ...Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) } as ScheduleInput;
    if (!v.name || !isValidScheduleName(v.name)) return 'give a short name (letters, digits, spaces and . _ - – — : ( ) ; max 60 characters).';
    if (!v.cron) return 'give a schedule (cron, e.g. "30 9 * * *" = every day at 09:30).';
    const bad = validateCron(v.cron, v.timezone || 'UTC');
    if (bad) return bad;
    if (v.kind !== 'message' && v.kind !== 'task') return 'kind must be "message" (post text to a chat) or "task" (start a task for an agent).';
    if (!v.text?.trim()) return v.kind === 'message' ? 'give the message text.' : 'give the task prompt.';
    if (v.text.length > 4000) return 'text is too long (max 4000 characters).';
    if ((v.quietStart && !isHM(v.quietStart)) || (v.quietEnd && !isHM(v.quietEnd))) return 'quiet hours are HH:MM, e.g. 22:00 and 08:00.';
    if (Boolean(v.quietStart) !== Boolean(v.quietEnd)) return 'give both quiet hours or neither.';
    if (v.kind === 'message' && (!v.channelId || !v.chatId)) return 'a message needs a channel and a chat to post to.';
    if (v.channelId || v.chatId) {
      if (!v.channelId || !v.chatId) return 'channel and chat go together.';
      const ch = await this.channels.getRow(v.channelId).catch(() => null);
      if (!ch) return 'unknown channel.';
      if (!this.channels.allowedChatIds(ch).includes(String(v.chatId))) return `chat ${v.chatId} is not in this channel's allowed chats — add it in Settings → Channels first.`;
    }
    if (v.kind === 'task') {
      if (v.taskMode !== undefined && v.taskMode !== 'same' && v.taskMode !== 'new') return 'taskMode must be "same" (every run continues one task) or "new" (every run starts a new task).';
      if (!v.agentName) return 'a task needs an agent.';
      if (!(await this.agents.get(v.agentName).catch(() => null))) return `no agent named "${v.agentName}".`;
    }
    return null;
  }

  async create(input: ScheduleInput, by?: string): Promise<ScheduleRow> {
    const bad = await this.validate(input);
    if (bad) throw new BadRequestException(bad);
    const tz = input.timezone || 'UTC';
    const cron = input.cron!.trim().replace(/\s+/g, ' ');
    const exists = await this.prisma.schedule.findUnique({ where: { name: input.name!.trim() } });
    if (exists) throw new BadRequestException(`a schedule named "${input.name}" already exists — update it instead.`);
    return this.prisma.schedule.create({
      data: {
        name: input.name!.trim(),
        enabled: input.enabled ?? true,
        cron,
        timezone: tz,
        kind: input.kind!,
        text: input.text!.trim(),
        agentName: input.kind === 'task' ? input.agentName ?? null : null,
        taskMode: input.kind === 'task' && input.taskMode === 'new' ? 'new' : 'same',
        channelId: input.channelId ?? null,
        chatId: input.chatId ? String(input.chatId) : null,
        quietStart: input.quietStart ?? null,
        quietEnd: input.quietEnd ?? null,
        nextRunAt: nextRun(cron, tz, new Date()),
        createdBy: by ?? null,
      },
    });
  }

  async update(id: string, input: ScheduleInput): Promise<ScheduleRow> {
    const cur = await this.get(id);
    const bad = await this.validate(input, cur);
    if (bad) throw new BadRequestException(bad);
    const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) } as ScheduleRow;
    const cron = next.cron.trim().replace(/\s+/g, ' ');
    return this.prisma.schedule.update({
      where: { id },
      data: {
        name: next.name.trim(),
        enabled: next.enabled,
        cron,
        timezone: next.timezone || 'UTC',
        kind: next.kind,
        text: next.text.trim(),
        agentName: next.kind === 'task' ? next.agentName : null,
        taskMode: next.kind === 'task' && next.taskMode === 'new' ? 'new' : 'same',
        // a different agent (or switching to "new") must not keep feeding the old conversation
        ...(next.agentName !== cur.agentName || next.kind !== cur.kind || next.taskMode === 'new' ? { taskId: null } : {}),
        channelId: next.channelId,
        chatId: next.chatId ? String(next.chatId) : null,
        quietStart: next.quietStart || null,
        quietEnd: next.quietEnd || null,
        nextRunAt: next.enabled ? nextRun(cron, next.timezone || 'UTC', new Date()) : null,
      },
    });
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.prisma.schedule.delete({ where: { id } });
  }

  /** Run once now, regardless of the clock (the schedule keeps its normal next time). */
  async runNow(id: string): Promise<{ status: string; error?: string }> {
    return this.execute(await this.get(id), new Date(), false);
  }

  /** Fire everything that is due. Safe to call concurrently: a row is claimed by moving its next time forward first. */
  async tick(now = new Date()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let ran = 0;
    try {
      const due = await this.prisma.schedule.findMany({ where: { enabled: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: 'asc' }, take: 20 });
      for (const row of due) {
        const scheduledFor = row.nextRunAt; // remember it: the claim below moves the row's next time forward
        let next: Date;
        try {
          next = nextRun(row.cron, row.timezone, now);
        } catch {
          await this.prisma.schedule.update({ where: { id: row.id }, data: { enabled: false, lastStatus: 'error', lastError: 'invalid schedule — disabled' } });
          continue;
        }
        const claimed = await this.prisma.schedule.updateMany({ where: { id: row.id, nextRunAt: scheduledFor }, data: { nextRunAt: next } });
        if (claimed.count !== 1) continue; // another instance took it
        const late = now.getTime() - (scheduledFor?.getTime() ?? now.getTime());
        if (late > GRACE_MS) {
          await this.prisma.schedule.update({ where: { id: row.id }, data: { lastStatus: 'skipped', lastError: 'missed while the server was off', lastRunAt: now } });
          continue;
        }
        await this.execute(row, now, true);
        ran += 1;
      }
    } finally {
      this.ticking = false;
    }
    return ran;
  }

  private async execute(row: ScheduleRow, now: Date, respectQuiet: boolean): Promise<{ status: string; error?: string }> {
    const record = async (status: string, error?: string) => {
      await this.prisma.schedule
        .update({ where: { id: row.id }, data: { lastRunAt: now, lastStatus: status, lastError: error ?? null } })
        .catch(() => undefined);
      return { status, error };
    };
    if (respectQuiet && inQuietHours(now, row.timezone, row.quietStart, row.quietEnd)) return record('skipped', 'quiet hours');
    try {
      if (row.kind === 'message') {
        const ok = await this.manager.sendText(row.channelId!, row.chatId!, `⏰ ${row.text}`);
        return ok ? record('ok') : record('error', 'could not deliver to the chat (is the channel enabled and the bot able to write there?)');
      }
      // "same" mode: keep working in ONE task — the run is a follow-up in the conversation the schedule started earlier (the agent
      // remembers the earlier runs). After ROLLOVER_MS the thread starts fresh so its context does not grow forever.
      if (row.taskMode !== 'new' && row.taskId) {
        const existing = await this.tasks.get(row.taskId).catch(() => null);
        if (existing && Date.now() - new Date(existing.createdAt).getTime() < ROLLOVER_MS) {
          try {
            await this.tasks.followUp(existing.id, row.text);
            return record('ok');
          } catch (err) {
            if (err instanceof ConflictException) return record('skipped', 'the previous run is still working and its queue is full');
            throw err;
          }
        }
      }
      const task = await this.tasks.create({ prompt: row.text, title: `⏰ ${row.name}`, agentName: row.agentName ?? undefined, createdByChannel: `schedule:${row.name}` });
      if (row.taskMode !== 'new') await this.prisma.schedule.update({ where: { id: row.id }, data: { taskId: task.id } }).catch(() => undefined);
      if (row.channelId && row.chatId) {
        await this.channels.linkThread(row.channelId, task.id, row.chatId);
        await this.channels.setChatState(row.channelId, row.chatId, { activeTaskId: task.id }).catch(() => undefined);
        await this.manager.sendText(row.channelId, row.chatId, `⏰ ${row.name}: started «${task.title}». Updates will appear here.`);
      }
      return record('ok');
    } catch (err) {
      this.logger.warn(`Schedule "${row.name}" failed: ${(err as Error).message}`);
      return record('error', (err as Error).message.slice(0, 300));
    }
  }
}
