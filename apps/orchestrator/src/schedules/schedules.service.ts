import { parseLevel } from '../approvals/approval-mode';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { isTerminalStatus } from '@lds/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { ChannelsService } from '../channels/channels.service';
import { ChannelManagerService } from '../channels/channel-manager.service';
import { AgentRegistryService } from '../agent-registry/agent-registry.service';
import { ProjectsService } from '../projects/projects.service';
import { knownProjectLabel } from '../projects/project-labels';
import { docsWorkDirOf } from '../projects/project-context';
import { runScript, DEFAULT_SCRIPT_TIMEOUT_SEC, MAX_SCRIPT_TIMEOUT_SEC } from './script-runner';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { AppConfigService } from '../config/app-config.service';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** approvals for the tasks this schedule starts: 'ask' | 'off', null / 'inherit' = follow the project / global setting */
  approvalMode?: string | null;
  /** script kind: seconds the script may run (default 600, max 6 h) */
  timeoutSec?: number | null;
  /** script kind: post to the chat `always` (default) or only when the script `failure`s */
  notifyOn?: string;
  /** slug of the project the scheduled task is created in (null / omitted = the default project) */
  project?: string | null;
}

const TICK_MS = 30_000;
/** In "same" mode a schedule's task is replaced by a fresh one after this long (keeps the conversation's context from growing without limit). */
const ROLLOVER_MS = 30 * 24 * 3600_000;
/** A run that is overdue by more than this (the server was off) is skipped rather than fired late. */
const GRACE_MS = 2 * 3600_000;
/** A chat whose active task was touched this recently is "in a conversation": a scheduled task does not take it over. */
const ACTIVE_CHAT_MS = 30 * 60_000;

/** The mime type of a file a script wrote, from its extension (pictures are sent as photos). */
function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', json: 'application/json', md: 'text/markdown' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

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
    lastOutput: r.lastOutput,
    timeoutSec: r.timeoutSec,
    notifyOn: r.notifyOn,
    agentName: r.agentName,
    taskMode: r.taskMode,
    taskId: r.taskId,
    channelId: r.channelId,
    chatId: r.chatId,
    quietStart: r.quietStart,
    quietEnd: r.quietEnd,
    approvalMode: parseLevel(r.approvalMode),
    projectId: r.projectId,
    project: r.projectId ? knownProjectLabel(r.projectId) : null,
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
  };
}

/**
 * Recurring jobs. Three kinds: `message` posts text to a chat (no model, free), `task` starts a task for an agent (its updates flow to the chat) and
 * `script` runs a shell script on the server (no model, free; only an operator / admin may create one, or the admin assistant through an approval card, never another agent). The next run time lives in the database, so a restart loses nothing; a run missed
 * while the server was off is skipped instead of fired hours late.
 */
@Injectable()
export class SchedulesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulesService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** Scripts that are running right now (a schedule never runs two at once). */
  private readonly scripts = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly channels: ChannelsService,
    private readonly manager: ChannelManagerService,
    private readonly agents: AgentRegistryService,
    private readonly projects: ProjectsService,
    @Optional() private readonly config?: AppConfigService,
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
  async validate(input: ScheduleInput, current?: ScheduleRow, opts: { allowScript?: boolean } = {}): Promise<string | null> {
    const v = { ...(current ?? {}), ...Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) } as ScheduleInput;
    if (!v.name || !isValidScheduleName(v.name)) return 'give a short name (letters, digits, spaces and . _ - – — : ( ) ; max 60 characters).';
    if (!v.cron) return 'give a schedule (cron, e.g. "30 9 * * *" = every day at 09:30).';
    const bad = validateCron(v.cron, v.timezone || 'UTC');
    if (bad) return bad;
    if (v.kind !== 'message' && v.kind !== 'task' && v.kind !== 'script') return 'kind must be "message" (post text to a chat), "task" (start a task for an agent) or "script" (run a shell script).';
    if (v.kind === 'script' && !opts.allowScript) return 'a script schedule can only be created or changed in the dashboard (Schedules) by an operator, or by the admin assistant with an approval — not by another agent or a pack.';
    if (!v.text?.trim()) return v.kind === 'message' ? 'give the message text.' : v.kind === 'script' ? 'give the script.' : 'give the task prompt.';
    if (v.text.length > (v.kind === 'script' ? 20000 : 4000)) return `text is too long (max ${v.kind === 'script' ? 20000 : 4000} characters).`;
    if (v.kind === 'script') {
      if (v.timeoutSec != null && (!Number.isInteger(Number(v.timeoutSec)) || Number(v.timeoutSec) < 1 || Number(v.timeoutSec) > MAX_SCRIPT_TIMEOUT_SEC)) return `the time limit is a whole number of seconds from 1 to ${MAX_SCRIPT_TIMEOUT_SEC}.`;
      if (v.notifyOn !== undefined && v.notifyOn !== 'always' && v.notifyOn !== 'failure') return 'notifyOn must be "always" or "failure".';
    }
    if ((v.quietStart && !isHM(v.quietStart)) || (v.quietEnd && !isHM(v.quietEnd))) return 'quiet hours are HH:MM, e.g. 22:00 and 08:00.';
    if (Boolean(v.quietStart) !== Boolean(v.quietEnd)) return 'give both quiet hours or neither.';
    if (v.approvalMode != null && v.approvalMode !== 'inherit' && parseLevel(v.approvalMode) === null) return 'approvalMode must be "ask", "off" or "inherit".';
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
    if (input.project) {
      const p = await this.projects.get(input.project).catch(() => null);
      if (!p) return `no project "${input.project}".`;
      if (p.archivedAt) return `project "${input.project}" is archived.`;
    }
    return null;
  }

  /** The project id a slug stands for (null = the default project); validated above. */
  private async projectIdOf(slug: string | null | undefined): Promise<string | null> {
    if (!slug) return null;
    const p = await this.projects.get(slug);
    return p.isDefault ? null : p.id;
  }

  async create(input: ScheduleInput, by?: string, opts: { allowScript?: boolean } = {}): Promise<ScheduleRow> {
    const bad = await this.validate(input, undefined, opts);
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
        approvalMode: parseLevel(input.approvalMode),
        ...(input.kind === 'script' ? { timeoutSec: input.timeoutSec ? Math.round(Number(input.timeoutSec)) : null, notifyOn: input.notifyOn === 'failure' ? 'failure' : 'always' } : {}),
        projectId: await this.projectIdOf(input.project),
        nextRunAt: nextRun(cron, tz, new Date()),
        createdBy: by ?? null,
      },
    });
  }

  async update(id: string, input: ScheduleInput, opts: { allowScript?: boolean } = {}): Promise<ScheduleRow> {
    const cur = await this.get(id);
    const bad = await this.validate(input, cur, opts);
    if (bad) throw new BadRequestException(bad);
    const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) } as ScheduleRow;
    const cron = next.cron.trim().replace(/\s+/g, ' ');
    const projectId = input.project === undefined ? cur.projectId : await this.projectIdOf(input.project);
    const updated = await this.prisma.schedule.update({
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
        // a different agent, chat or channel (or switching to "new") must not keep feeding the old conversation: its thread is bound to the old chat
        ...(next.agentName !== cur.agentName || next.kind !== cur.kind || next.taskMode === 'new' || (next.channelId ?? null) !== cur.channelId || (next.chatId ? String(next.chatId) : null) !== cur.chatId || projectId !== cur.projectId
          ? { taskId: null }
          : {}),
        projectId,
        channelId: next.channelId,
        chatId: next.chatId ? String(next.chatId) : null,
        quietStart: next.quietStart || null,
        quietEnd: next.quietEnd || null,
        approvalMode: input.approvalMode === undefined ? cur.approvalMode : parseLevel(input.approvalMode),
        ...(next.kind === 'script' ? { timeoutSec: next.timeoutSec ? Math.round(Number(next.timeoutSec)) : null, notifyOn: next.notifyOn === 'failure' ? 'failure' : 'always' } : {}),
        nextRunAt: next.enabled ? nextRun(cron, next.timezone || 'UTC', new Date()) : null,
      },
    });
    // the ongoing task of a "same" schedule takes the new level at once (also back to "follow the project"), not only at the next run
    if (input.approvalMode !== undefined && cur.taskId && parseLevel(input.approvalMode) !== parseLevel(cur.approvalMode)) {
      await this.prisma.task.update({ where: { id: cur.taskId }, data: { approvalMode: parseLevel(input.approvalMode) } }).catch(() => undefined);
    }
    return updated;
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

  /** The chat's active task is still being worked on, or the person touched it recently (a conversation in progress). */
  private async chatBusy(channelId: string, chatId: string): Promise<boolean> {
    try {
      const state = await this.channels.chatState(channelId, chatId);
      if (!state?.activeTaskId) return false;
      const task = await this.tasks.get(state.activeTaskId);
      return !isTerminalStatus(task.status) || Date.now() - new Date(task.updatedAt).getTime() < ACTIVE_CHAT_MS;
    } catch {
      return false; // no state / the task is gone: nothing to protect
    }
  }

  /** The schedule's own approval level goes onto the task it starts (its subtasks follow it); not set = the task follows the project / global level. */
  private async applyApprovalMode(taskId: string, row: ScheduleRow): Promise<void> {
    const mode = parseLevel(row.approvalMode);
    if (!mode) return;
    await this.prisma.task.update({ where: { id: taskId }, data: { approvalMode: mode } }).catch((err) => this.logger.warn(`Schedule "${row.name}": could not set the approval level of task ${taskId}: ${(err as Error).message}`));
  }

  /** Where a script runs: the schedule's project folder (the checkout, or the documents folder), else an empty scratch folder. */
  private async scriptDir(row: ScheduleRow): Promise<string> {
    try {
      const ctx = await this.projects.contextFor(row.projectId ? { projectId: row.projectId } : undefined);
      const dir = ctx.kind === 'code' ? ctx.repoPath : docsWorkDirOf(ctx);
      if (dir && (await stat(dir).then((s) => s.isDirectory()).catch(() => false))) return dir;
    } catch {
      /* the project is gone: the scratch folder */
    }
    const scratch = join(tmpdir(), 'aigentron-scripts');
    await mkdir(scratch, { recursive: true });
    return scratch;
  }

  /**
   * The files a script left in its output folder go to the schedule's chat: pictures as photos, the rest as documents (at most 10, up to 25 MB each), with the
   * run's result as the caption (always for a failure; for a good run unless the schedule posts only failures). Returns how many files were sent.
   */
  private async postOutputFiles(row: ScheduleRow, outDir: string, r: { exitCode: number | null; timedOut: boolean; output: string; ms: number }): Promise<number> {
    if (!row.channelId || !row.chatId) return 0;
    const names = (await readdir(outDir).catch(() => [] as string[])).sort().slice(0, 10);
    const files: { data: Buffer; filename: string; mime: string }[] = [];
    for (const name of names) {
      const path = join(outDir, name);
      const st = await stat(path).catch(() => null);
      if (!st?.isFile() || st.size === 0 || st.size > 25 * 1024 * 1024) continue;
      files.push({ data: await readFile(path), filename: name, mime: mimeOf(name) });
    }
    if (!files.length) return 0;
    const ok = r.exitCode === 0 && !r.timedOut;
    const text = r.output.trim().slice(-700);
    const caption = `⏰ ${row.name}${ok ? '' : ' ❌'}${text ? `\n${text}` : ''}`.slice(0, 1000);
    return (await this.manager.sendFiles(row.channelId, row.chatId, files, caption)) ? files.length : 0;
  }

  /** One run of a script schedule: runs it, keeps what it printed, tells the chat (every run, or only a failure). */
  private async executeScript(row: ScheduleRow, now: Date, record: (status: string, error?: string) => Promise<{ status: string; error?: string }>): Promise<{ status: string; error?: string }> {
    if (this.scripts.has(row.id)) return record('skipped', 'the previous run is still working');
    this.scripts.add(row.id);
    try {
      const timeoutSec = row.timeoutSec ?? DEFAULT_SCRIPT_TIMEOUT_SEC;
      // two folders for the script: LDS_DATA_DIR keeps what it needs between runs (a history file), LDS_OUTPUT_DIR is empty at every start — what the
      // script leaves there is posted to the chat afterwards and deleted (a chart: draw it, the server sends it, nothing stays on disk)
      const dataDir = join(this.config ? join(this.config.secretsDir, '..', 'schedule-data') : join(tmpdir(), 'aigentron-schedule-data'), row.id);
      await mkdir(dataDir, { recursive: true });
      const outDir = await mkdtemp(join(tmpdir(), 'aigentron-out-'));
      let r;
      let sentFiles = 0;
      try {
        r = await runScript(row.text, { cwd: await this.scriptDir(row), timeoutSec, extraEnv: { LDS_SCHEDULE: row.name, LDS_DATA_DIR: dataDir, LDS_OUTPUT_DIR: outDir } });
        sentFiles = await this.postOutputFiles(row, outDir, r);
      } finally {
        await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
      }
      const ok = r.exitCode === 0 && !r.timedOut;
      const why = r.timedOut ? `stopped after ${timeoutSec} s (time limit)` : r.exitCode === null ? `could not run (${r.output.split('\n')[0]?.slice(0, 120) || 'unknown'})` : `exit code ${r.exitCode}`;
      await this.prisma.schedule.update({ where: { id: row.id }, data: { lastOutput: r.output.slice(-4000) || null } }).catch(() => undefined);
      if (row.channelId && row.chatId && sentFiles === 0 && (!ok || row.notifyOn !== 'failure')) {
        const tail = r.output.trim().slice(-1500);
        const head = ok ? `⏰ ${row.name}: ✅ done in ${Math.max(1, Math.round(r.ms / 1000))} s` : `⏰ ${row.name}: ❌ ${why}`;
        await this.manager.sendText(row.channelId, row.chatId, tail ? `${head}\n${tail}` : head);
      }
      return record(ok ? 'ok' : 'error', ok ? undefined : why);
    } finally {
      this.scripts.delete(row.id);
    }
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
      if (row.kind === 'script') return await this.executeScript(row, now, record);
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
            await this.applyApprovalMode(existing.id, row);
            await this.tasks.followUp(existing.id, row.text);
            return record('ok');
          } catch (err) {
            if (err instanceof ConflictException) return record('skipped', 'the previous run is still working and its queue is full');
            throw err;
          }
        }
      }
      // the task goes into the schedule's project (a deleted project has set the column to null = default)
      const project = row.projectId ? (await this.projects.getById(row.projectId).catch(() => null))?.slug : undefined;
      const task = await this.tasks.create({ prompt: row.text, title: `⏰ ${row.name}`, agentName: row.agentName ?? undefined, createdByChannel: `schedule:${row.name}`, project });
      await this.applyApprovalMode(task.id, row);
      if (row.taskMode !== 'new') await this.prisma.schedule.update({ where: { id: row.id }, data: { taskId: task.id } }).catch(() => undefined);
      if (row.channelId && row.chatId) {
        await this.channels.linkThread(row.channelId, task.id, row.chatId);
        // The chat follows the scheduled task only when nobody is in the middle of something there: a person talking to an
        // agent must not have their next message hijacked by a schedule that happened to fire (C-16).
        if (!(await this.chatBusy(row.channelId, row.chatId))) await this.channels.setChatState(row.channelId, row.chatId, { activeTaskId: task.id }).catch(() => undefined);
        await this.manager.sendText(row.channelId, row.chatId, `⏰ ${row.name}: started «${task.title}». Updates will appear here.`);
      }
      return record('ok');
    } catch (err) {
      this.logger.warn(`Schedule "${row.name}" failed: ${(err as Error).message}`);
      return record('error', (err as Error).message.slice(0, 300));
    }
  }
}
