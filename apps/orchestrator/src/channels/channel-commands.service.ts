import { Injectable } from '@nestjs/common';
import { isTerminalStatus } from '@lds/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { TasksService } from '../tasks/tasks.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ProvidersService } from '../providers/providers.service';
import { AgentRegistryService } from '../agent-registry/agent-registry.service';
import { SettingsService } from '../settings/settings.service';
import { ChannelsService } from './channels.service';
import { HELP_TEXT } from './command-menu';
import type { MessageButton } from './channel-adapter';

const HELP = HELP_TEXT;
/** Telegram (and presumably any other transport) caps callback_data at 64
 *  bytes; `tk:` + a task id comfortably fits, but keep the constant named so
 *  it reads as a deliberate limit, not a random slice. */
const MAX_BUTTON_LABEL = 64;

interface CommandCtx {
  channelId: string;
  chatId: string;
  userId: string;
  kind: string;
}

/** A command's reply: plain text, optionally with tappable buttons (e.g. a
 *  task list where each row switches the chat's active task). */
export interface CommandReply {
  text: string;
  buttons?: MessageButton[][];
}

/**
 * Parses and executes slash commands from a channel conversation and returns a
 * single readable reply (no noise). State (active task, chosen agent/model)
 * lives per (channel, chat) so a plain message continues the active task.
 */
@Injectable()
export class ChannelCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly channels: ChannelsService,
    private readonly tasks: TasksService,
    private readonly approvals: ApprovalsService,
    private readonly providers: ProvidersService,
    private readonly agents: AgentRegistryService,
    private readonly settings: SettingsService,
  ) {}

  isCommand(text: string): boolean {
    return text.trim().startsWith('/');
  }

  async handle(ctx: CommandCtx, text: string): Promise<string | CommandReply> {
    const trimmed = text.trim();
    const cmd = trimmed.split(/\s+/)[0]!.toLowerCase();
    const arg = trimmed.slice(cmd.length).trim();
    switch (cmd) {
      case '/start':
      case '/help':
        return HELP;
      case '/clear':
        return this.clear(ctx);
      case '/new_task':
      case '/new':
        return this.newTask(ctx, arg);
      case '/tasks':
        return this.listTasks(ctx);
      case '/task':
        return this.switchTask(ctx, arg);
      case '/status':
        return this.status(ctx);
      case '/subtasks':
        return this.subtasks(ctx);
      case '/cancel':
        return this.cancel(ctx);
      case '/approve':
        return this.decide(ctx, 'approve');
      case '/deny':
        return this.decide(ctx, 'deny');
      case '/pr':
        return this.pr(ctx);
      case '/web':
        return this.web(ctx);
      case '/settings':
      case '/me':
        return this.showSettings(ctx);
      case '/mute':
        return this.mute(ctx, true);
      case '/unmute':
        return this.mute(ctx, false);
      case '/compress':
        return this.compress(ctx);
      case '/models':
        return this.listModels(ctx);
      case '/model':
        return this.setModel(ctx, arg);
      case '/agents':
        return this.listAgents(ctx);
      case '/agent':
        return this.setAgent(ctx, arg);
      default:
        return `Unknown command ${cmd}.\n\n${HELP}`;
    }
  }

  // ---- handlers ------------------------------------------------------------

  private async clear(ctx: CommandCtx): Promise<string> {
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { activeTaskId: null });
    return '🧹 Cleared. Your next message starts a new task.';
  }

  async newTask(ctx: CommandCtx, text: string): Promise<string> {
    if (!text) {
      await this.channels.setChatState(ctx.channelId, ctx.chatId, { activeTaskId: null });
      return '📝 Send the task description as your next message.';
    }
    const state = await this.channels.chatState(ctx.channelId, ctx.chatId);
    const task = await this.tasks.create({
      prompt: text,
      agentName: state.agent ?? undefined,
      provider: state.model ?? undefined,
      createdByChannel: `${ctx.kind}:${ctx.userId}`,
    });
    await this.channels.linkThread(ctx.channelId, task.id, ctx.chatId);
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { activeTaskId: task.id });
    return `✅ New task «${task.title}» (${shortId(task.id)}). Updates will appear here.`;
  }

  private async listTasks(ctx: CommandCtx): Promise<CommandReply> {
    const [{ items: rows }, state] = await Promise.all([
      this.tasks.list({ pageSize: 10 }),
      this.channels.chatState(ctx.channelId, ctx.chatId),
    ]);
    if (!rows.length) return { text: 'No tasks yet. Use /new-task <text>.' };
    const top = rows.slice(0, 10);
    return {
      text: 'Recent tasks — tap one to switch:',
      buttons: top.map((t) => [taskButton(t.id, t.title, t.status, t.id === state.activeTaskId)]),
    };
  }

  /** Switch the chat's active task to an EXACT id (button tap — no fuzzy match
   *  needed, we already resolved it). Shared with switchTask() below. */
  async switchToTaskById(ctx: CommandCtx, taskId: string): Promise<string> {
    const task = await this.tasks.get(taskId).catch(() => null);
    if (!task) return 'Task not found (it may have been deleted). See /tasks.';
    await this.channels.linkThread(ctx.channelId, task.id, ctx.chatId);
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { activeTaskId: task.id });
    return `▶ Now on «${task.title}» (${shortId(task.id)}) — ${task.status}.\n${await this.channels.summarize(task.id)}`;
  }

  private async switchTask(ctx: CommandCtx, arg: string): Promise<string> {
    if (!arg) return 'Usage: /task <id>';
    // Match against a recent window by id/suffix/short-id (the messenger passes
    // a short id, which the free-text search can't match on its own).
    const { items: rows } = await this.tasks.list({ pageSize: 100 });
    const task = rows.find((t) => t.id === arg || t.id.endsWith(arg) || shortId(t.id) === arg);
    if (!task) return `Task not found: ${arg}. See /tasks.`;
    return this.switchToTaskById(ctx, task.id);
  }

  private async compress(ctx: CommandCtx): Promise<string> {
    const state = await this.channels.chatState(ctx.channelId, ctx.chatId);
    if (!state.activeTaskId) return 'No active task. Use /task <id> or /new-task <text>.';
    return `🗜 Active task summary:\n${await this.channels.summarize(state.activeTaskId)}`;
  }

  private async listModels(ctx: CommandCtx): Promise<string> {
    const [providers, def, state] = await Promise.all([
      this.providers.list(),
      this.settings.defaultProvider(),
      this.channels.chatState(ctx.channelId, ctx.chatId),
    ]);
    const current = state.model ?? def;
    const lines = providers.map(
      (p) => `${p.name === current ? '▶' : '·'} ${p.name}${p.model ? ` (${p.model})` : ''}`,
    );
    return `Models:\n${lines.join('\n')}\n\nUse /model <name>.`;
  }

  private async setModel(ctx: CommandCtx, arg: string): Promise<string> {
    if (!arg) return 'Usage: /model <name>. See /models.';
    const provider = await this.providers.get(arg).catch(() => null);
    if (!provider) return `Model not found: ${arg}. See /models.`;
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { model: arg });
    return `✅ Model set to ${arg} for new tasks in this chat.`;
  }

  private async listAgents(ctx: CommandCtx): Promise<string> {
    const [agents, def, state] = await Promise.all([
      this.agents.list(),
      this.settings.defaultAgent(),
      this.channels.chatState(ctx.channelId, ctx.chatId),
    ]);
    const current = state.agent ?? def;
    const lines = agents.map((a) => {
      const line = `${a.name === current ? '▶' : '·'} ${a.name}${a.description ? ` — ${a.description}` : ''}`;
      return line.length > 120 ? `${line.slice(0, 117)}…` : line;
    });
    return `Agents:\n${lines.join('\n')}\n\nUse /agent <name>.`;
  }

  private async setAgent(ctx: CommandCtx, arg: string): Promise<string> {
    if (!arg) return 'Usage: /agent <name>. See /agents.';
    const agent = await this.agents.get(arg).catch(() => null);
    if (!agent) return `Agent not found: ${arg}. See /agents.`;
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { agent: arg });
    return `✅ Agent set to ${arg} for new tasks in this chat.`;
  }

  private async status(ctx: CommandCtx): Promise<string> {
    const id = await this.activeTaskId(ctx);
    if (!id) return 'No active task. Use /new_task <text>.';
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: { title: true, status: true, agentName: true, providerOverride: true },
    });
    if (!task) return 'Active task no longer exists. Use /clear.';
    const subs = await this.prisma.task.findMany({ where: { parentId: id }, select: { status: true } });
    const model = task.providerOverride ? ` · model: ${task.providerOverride}` : '';
    const subLine = subs.length ? `\nSubtasks: ${countByStatus(subs.map((s) => s.status))}` : '';
    return `▶ «${task.title}» — ${task.status}\nagent: ${task.agentName ?? 'default'}${model}${subLine}\n${await this.channels.summarize(id)}`;
  }

  private async subtasks(ctx: CommandCtx): Promise<string | CommandReply> {
    const id = await this.activeTaskId(ctx);
    if (!id) return 'No active task.';
    const subs = await this.prisma.task.findMany({
      where: { parentId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, title: true, status: true },
    });
    if (!subs.length) return 'No subtasks for the active task.';
    return {
      text: 'Subtasks — tap one to switch:',
      buttons: subs.map((s) => [taskButton(s.id, s.title, s.status)]),
    };
  }

  private async cancel(ctx: CommandCtx): Promise<string> {
    const id = await this.activeTaskId(ctx);
    if (!id) return 'No active task.';
    const task = await this.tasks.get(id).catch(() => null);
    if (!task) return 'Active task no longer exists.';
    if (isTerminalStatus(task.status)) return `Task is already ${task.status}.`;
    await this.tasks.cancel(id);
    return '🛑 Cancelled the active task.';
  }

  private async decide(ctx: CommandCtx, decision: 'approve' | 'deny'): Promise<string> {
    const id = await this.activeTaskId(ctx);
    if (!id) return 'No active task.';
    const pending = await this.prisma.approvalRequest.findFirst({
      where: { taskId: id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!pending) return 'No pending approval for the active task.';
    await this.approvals.decide(pending.id, decision, { displayName: `${ctx.kind}:${ctx.userId}` });
    return decision === 'approve' ? '✅ Approved.' : '⛔ Denied.';
  }

  private async pr(ctx: CommandCtx): Promise<string> {
    const id = await this.activeTaskId(ctx);
    if (!id) return 'No active task.';
    const task = await this.prisma.task.findUnique({ where: { id }, select: { prUrl: true, branch: true } });
    if (task?.prUrl) return task.prUrl;
    return task?.branch ? `No PR yet (branch ${task.branch}).` : 'No PR yet.';
  }

  private async web(ctx: CommandCtx): Promise<string> {
    const id = await this.activeTaskId(ctx);
    return id ? `${this.config.dashboardBaseUrl}/tasks/${id}` : this.config.dashboardBaseUrl;
  }

  private async showSettings(ctx: CommandCtx): Promise<string> {
    const [state, defAgent, defProvider] = await Promise.all([
      this.channels.chatState(ctx.channelId, ctx.chatId),
      this.settings.defaultAgent(),
      this.settings.defaultProvider(),
    ]);
    let active = 'none';
    if (state.activeTaskId) {
      const t = await this.prisma.task.findUnique({
        where: { id: state.activeTaskId },
        select: { title: true, status: true },
      });
      active = t ? `«${t.title}» (${t.status})` : '(deleted)';
    }
    return [
      `Active task: ${active}`,
      `Agent: ${state.agent ?? `${defAgent ?? 'default'} (default)`}`,
      `Model: ${state.model ?? `${defProvider} (default)`}`,
      `Muted: ${state.muted ? 'yes' : 'no'}`,
    ].join('\n');
  }

  private async mute(ctx: CommandCtx, on: boolean): Promise<string> {
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { muted: on });
    return on
      ? '🔕 Muted routine updates (approvals are still sent). /unmute to restore.'
      : '🔔 Unmuted — you will get task updates again.';
  }

  private async activeTaskId(ctx: CommandCtx): Promise<string | null> {
    return (await this.channels.chatState(ctx.channelId, ctx.chatId)).activeTaskId ?? null;
  }
}

/** e.g. "2 done, 1 running" from a list of statuses. */
function countByStatus(statuses: string[]): string {
  const counts = new Map<string, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(', ');
}

function shortId(id: string): string {
  return id.slice(-6);
}

/** One task-list row's button: label shows status + title, data carries the
 *  full id (`tk:` prefix, parsed by the adapter's callback_query handler). */
function taskButton(id: string, title: string, status: string, active = false): MessageButton {
  const label = `${active ? '▶ ' : ''}[${status}] ${title}`;
  return {
    label: label.length > MAX_BUTTON_LABEL ? `${label.slice(0, MAX_BUTTON_LABEL - 1)}…` : label,
    data: `tk:${id}`,
  };
}
