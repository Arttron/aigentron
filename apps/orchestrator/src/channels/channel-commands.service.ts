import { parsePinnedAgents } from '../projects/project-core';
import { VoiceService } from '../voice/voice.service';
import { ModuleRef } from '@nestjs/core';
import { Injectable } from '@nestjs/common';
import { isTerminalStatus } from '@lds/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { TasksService } from '../tasks/tasks.service';
import { ProjectsService } from '../projects/projects.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ProvidersService } from '../providers/providers.service';
import { AgentRegistryService } from '../agent-registry/agent-registry.service';
import { SettingsService } from '../settings/settings.service';
import { ChannelsService } from './channels.service';
import { COMMAND_MENU, HELP_TEXT } from './command-menu';
import { commandKey, matchAgent, parseAddress } from './agent-match';
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
/** `/Tasks@MyBot` (how Telegram writes a command in a group) → `/tasks`. */
export function commandName(text: string): string {
  return text.trim().split(/\s+/)[0]!.toLowerCase().replace(/@\w+$/, '');
}

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
    private readonly voice: VoiceService,
    private readonly moduleRef: ModuleRef,
    private readonly projects: ProjectsService,
  ) {}

  /** The project this chat is bound to (its notification chat), or null: then every project's tasks are visible and new tasks go to the default project. */
  private boundProject(ctx: CommandCtx) {
    return this.projects.boundToChat(ctx.channelId, ctx.chatId).catch(() => null);
  }

  // ---- addressing an agent: `/pm text`, `@pm text` ----

  /** Names that already mean a built-in command (an agent of that name is reached with @name). */
  private builtinKeys(): Set<string> {
    return new Set([...COMMAND_MENU.map((c) => c.command), 'start', 'help', 'new', 'me', 'mute', 'unmute']);
  }

  /**
   * The agents a chat may see and address: all of them in an ordinary chat; in a chat bound to a project only that project's (its pinned agents, else its
   * default agent) and the admin — the fleet is not shown to a project's people. `project` is the bound project row, if any.
   */
  async visibleAgents(project: { pinnedAgents?: unknown; defaultAgent?: string | null } | null): Promise<Set<string> | null> {
    if (!project) return null;
    const pinned = parsePinnedAgents(project.pinnedAgents as string | null | undefined);
    return new Set([...(pinned.length ? pinned : project.defaultAgent?.trim() ? [project.defaultAgent.trim()] : []), 'admin']);
  }

  /** Every agent with the command it can be reached by (null = no command of its own: a clash with a built-in or another agent). */
  async agentDirectory(visible: Set<string> | null = null): Promise<{ name: string; description: string; key: string | null }[]> {
    const builtin = this.builtinKeys();
    const used = new Set<string>();
    return (await this.agents.list()).filter((a) => !visible || visible.has(a.name)).map((a) => {
      const k = commandKey(a.name);
      const key = k && !builtin.has(k) && !used.has(k) ? k : null;
      if (key) used.add(key);
      return { name: a.name, description: (a.description ?? '').replace(/\s+/g, ' ').trim(), key };
    });
  }

  /** The command menu entries for the agents (Telegram shows them, with autocomplete, when the person types `/`). */
  async agentCommands(channelId?: string): Promise<{ command: string; description: string }[]> {
    const room = Math.max(0, 100 - COMMAND_MENU.length);
    // a channel that belongs to a project shows only that project's agents in its menu
    const owner = channelId ? await this.projects.boundToChat(channelId, '\u0000channel').catch(() => null) : null;
    return (await this.agentDirectory(await this.visibleAgents(owner)))
      .filter((a) => a.key)
      .slice(0, room)
      .map((a) => ({ command: a.key!, description: (a.description || `Talk to ${a.name}`).slice(0, 100) }));
  }

  /**
   * Is this message addressed to an agent (`/pm …` or `@pm …`)? Typos in the name are forgiven. Returns the agent and the rest of the
   * message, or a `reply` when it cannot tell which one was meant. `null` = not an address (an ordinary message or a built-in command).
   */
  async resolveAddress(text: string, ctx?: CommandCtx): Promise<{ agent: string; rest: string; typed: string; fuzzy: boolean } | { reply: string } | null> {
    const addr = parseAddress(text);
    if (!addr) return null;
    const key = commandKey(addr.typed);
    if (addr.symbol === '/' && key && this.builtinKeys().has(key)) return null; // a built-in command
    const dir = await this.agentDirectory(await this.visibleAgents(ctx ? await this.boundProject(ctx) : null));
    const m = matchAgent(addr.typed, dir);
    const link = (name: string) => {
      const a = dir.find((d) => d.name === name);
      return a?.key ? `/${a.key}` : `@${name}`;
    };
    if (m.kind === 'exact' || m.kind === 'fuzzy') return { agent: m.name, rest: addr.rest, typed: addr.typed, fuzzy: m.kind === 'fuzzy' };
    if (m.kind === 'ambiguous') return { reply: `🤔 «${addr.typed}» could be ${m.names.map(link).join(', ')} — tap or type the one you mean.` };
    // not an agent: an @-word is just text; an unknown /word gets a hint
    if (addr.symbol === '@') return null;
    return m.suggestions.length ? { reply: `Unknown command /${addr.typed}. Did you mean ${m.suggestions.map(link).join(' or ')}?` } : null;
  }

  isCommand(text: string): boolean {
    return text.trim().startsWith('/');
  }

  async handle(ctx: CommandCtx, text: string): Promise<string | CommandReply> {
    const trimmed = text.trim();
    const cmd = commandName(trimmed);
    const arg = trimmed.replace(/^\S+/, '').trim();
    switch (cmd) {
      case '/start':
      case '/help':
        return HELP;
      case '/clear':
        return this.clear(ctx);
      case '/new_task':
      case '/new':
        return this.newTask(ctx, arg).then((r) => r.text);
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
      case '/voice':
        return this.voiceCmd(ctx, arg.toLowerCase());
      case '/progress':
        return this.progressCmd(ctx, arg.toLowerCase());
      case '/done': {
        const id = await this.activeTaskId(ctx);
        if (!id) return 'No active task. Use /tasks.';
        return this.tasks
          .markDone(id)
          .then(async () => {
            const open = await this.tasks.openSubtaskCount(id).catch(() => 0);
            return open ? `✅ Marked as done. ${open} subtask(s) are still open — they were left as they are.` : '✅ Marked as done.';
          })
          .catch((e) => `⚠️ ${(e as Error).message}`);
      }
      case '/continue': {
        const id = await this.activeTaskId(ctx);
        if (!id) return 'No active task. Use /tasks.';
        const text = arg.trim() || 'Continue the task from where you left off. Finish the remaining work, then report your status.';
        return this.tasks
          .followUp(id, text)
          .then((r) => (r.queued ? '📥 Queued — will run once the current turn finishes.' : '▶ Continuing the task.'))
          .catch((e) => `⚠️ ${(e as Error).message}`);
      }
      case '/discuss':
        return this.discuss(ctx, arg);
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

  /** `taskId` is null when nothing was actually created (e.g. the empty-text
   *  prompt below) — callers that want to react/track the run key off that. */
  async newTask(ctx: CommandCtx, text: string, agentOverride?: string): Promise<{ text: string; taskId: string | null }> {
    if (!text) {
      await this.channels.setChatState(ctx.channelId, ctx.chatId, { activeTaskId: null });
      return { text: '📝 Send the task description as your next message.', taskId: null };
    }
    const state = await this.channels.chatState(ctx.channelId, ctx.chatId);
    const bound = await this.boundProject(ctx);
    const agent = await this.agentForNewTask(ctx, state.agent ?? null, agentOverride, bound?.defaultAgent ?? null);
    const task = await this.tasks.create({
      prompt: text,
      project: bound?.slug,
      agentName: agent.name,
      provider: state.model ?? undefined,
      createdByChannel: `${ctx.kind}:${ctx.userId}`,
    });
    await this.channels.linkThread(ctx.channelId, task.id, ctx.chatId);
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { activeTaskId: task.id });
    const who = task.agentName ?? agent.name ?? 'the default lead';
    const why = agent.source === 'chat' ? ` — this chat's agent (/agent default goes back to the project's)` : '';
    return { text: `✅ New task «${task.title}» (${shortId(task.id)}) → ${who}${why}. Updates will appear here.`, taskId: task.id };
  }

  /**
   * Who a new task from this chat goes to: the agent addressed in the message, else the one this chat was set to (`/agent`, or an agent addressed by name alone),
   * else the bound project's default agent (applied by the task itself), else the channel's own default agent, else the installation's default lead.
   */
  async agentForNewTask(ctx: CommandCtx, chat: string | null, override: string | undefined, projectDefault: string | null): Promise<{ name: string | undefined; source: 'message' | 'chat' | 'channel' | 'default' }> {
    if (override) return { name: override, source: 'message' };
    // the chat's own choice — unless that agent has been deleted since (then the default, instead of a failure on every message)
    if (chat && (await this.agents.get(chat).then(() => true, () => false))) return { name: chat, source: 'chat' };
    if (projectDefault?.trim()) return { name: undefined, source: 'default' }; // the project's own default lead: the task applies it
    const channel = await this.channels.getRow(ctx.channelId).then((r) => this.channels.defaultAgent(r)).catch(() => undefined);
    return channel ? { name: channel, source: 'channel' } : { name: undefined, source: 'default' };
  }

  private async listTasks(ctx: CommandCtx): Promise<CommandReply> {
    const bound = await this.boundProject(ctx);
    const [{ items: rows }, state] = await Promise.all([
      this.tasks.list({ pageSize: 10, ...(bound ? { project: bound.slug } : {}) }),
      this.channels.chatState(ctx.channelId, ctx.chatId),
    ]);
    if (!rows.length) return { text: bound ? `No tasks in «${bound.name}» yet. Use /new-task <text>.` : 'No tasks yet. Use /new-task <text>.' };
    const top = rows.slice(0, 10);
    return {
      text: bound ? `Recent tasks of «${bound.name}» — tap one to switch:` : 'Recent tasks — tap one to switch:',
      buttons: top.map((t) => [taskButton(t.id, t.title, t.status, t.id === state.activeTaskId)]),
    };
  }

  /** Switch the chat's active task to an EXACT id (button tap — no fuzzy match
   *  needed, we already resolved it). Shared with switchTask() below. */
  async switchToTaskById(ctx: CommandCtx, taskId: string): Promise<string> {
    const task = await this.tasks.get(taskId).catch(() => null);
    if (!task) return 'Task not found (it may have been deleted). See /tasks.';
    const bound = await this.boundProject(ctx);
    if (bound && task.projectId !== bound.id) return `That task is not in «${bound.name}», the project of this chat. See /tasks.`;
    await this.channels.linkThread(ctx.channelId, task.id, ctx.chatId);
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { activeTaskId: task.id });
    return `▶ Now on «${task.title}» (${shortId(task.id)}) — ${task.status}.\n${await this.channels.summarize(task.id)}`;
  }

  private async switchTask(ctx: CommandCtx, arg: string): Promise<string> {
    if (!arg) return 'Usage: /task <id>';
    // Match against a recent window by id/suffix/short-id (the messenger passes
    // a short id, which the free-text search can't match on its own).
    const bound = await this.boundProject(ctx);
    const { items: rows } = await this.tasks.list({ pageSize: 100, ...(bound ? { project: bound.slug } : {}) });
    const task = rows.find((t) => t.id === arg || t.id.endsWith(arg) || shortId(t.id) === arg);
    if (!task) return `Task not found: ${arg}. See /tasks.`;
    return this.switchToTaskById(ctx, task.id);
  }

  private async compress(ctx: CommandCtx): Promise<string> {
    const id = await this.activeTaskId(ctx);
    if (!id) return 'No active task. Use /task <id> or /new-task <text>.';
    return `🗜 Active task summary:\n${await this.channels.summarize(id)}`;
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
    const [dir, def, state] = await Promise.all([this.boundProject(ctx).then((b) => this.visibleAgents(b)).then((v) => this.agentDirectory(v)), this.settings.defaultAgent(), this.channels.chatState(ctx.channelId, ctx.chatId)]);
    const current = state.agent ?? def;
    // `/name` is a tappable link in Telegram: tapping it picks the agent; `/name text` (or `@name text`) sends it a message.
    const lines = dir.map((a) => {
      const handle = a.key ? `/${a.key}` : `@${a.name}`;
      const line = `${a.name === current ? '▶' : '·'} ${handle}${a.description ? ` — ${a.description}` : ''}`;
      return line.length > 140 ? `${line.slice(0, 137)}…` : line;
    });
    return `Agents — tap a name to talk to it:\n${lines.join('\n')}\n\n/name text (or @name text) sends that agent a message — small typos in the name are fine. /agent <name> sets who starts new tasks (▶ now).`;
  }

  /** `/discuss pm architect: topic` — the agents talk to each other in a new chat (rounds=N as the first word sets the length). */
  private async discuss(ctx: CommandCtx, arg: string): Promise<string> {
    const usage = 'Usage: /discuss <agent> <agent> [more]: <topic> — e.g. /discuss pm architect: should we rewrite the app? (optional rounds=2 first). See /agents.';
    const colon = arg.indexOf(':');
    if (colon < 1) return usage;
    let names = arg.slice(0, colon).split(/[\s,]+/).filter(Boolean).map((n) => n.replace(/^[/@]/, ''));
    const topic = arg.slice(colon + 1).trim();
    let rounds: number | undefined;
    const r = names.find((n) => /^rounds?=\d+$/i.test(n));
    if (r) {
      rounds = Number(r.split('=')[1]);
      names = names.filter((n) => n !== r);
    }
    // `lang=user`: the agents talk in the person's language (costs more tokens); by default they talk terse English and the conclusion is in the person's language
    const lang = names.find((n) => /^lang(?:uage)?=user$/i.test(n)) ? 'user' : 'compact';
    names = names.filter((n) => !/^lang(?:uage)?=/i.test(n));
    if (names.length < 2 || !topic) return usage;
    const { DiscussionService } = await import('../discussion/discussion.service');
    try {
      const { taskId } = await this.moduleRef.get(DiscussionService, { strict: false }).start({ topic, agents: names, rounds, language: lang, summaryBy: names[0], createdByChannel: `${ctx.kind}:${ctx.userId}`, project: (await this.boundProject(ctx))?.slug });
      await this.channels.linkThread(ctx.channelId, taskId, ctx.chatId);
      await this.channels.setChatState(ctx.channelId, ctx.chatId, { activeTaskId: taskId });
      return `💬 Discussion started: ${names.join(', ')}. Their messages appear here one by one — write in this chat to join in (they answer you first); /cancel stops it.`;
    } catch (e) {
      return `⚠️ ${(e as Error).message.replace(/^\d+ [^—]*— /, '')}`;
    }
  }

  private async setAgent(ctx: CommandCtx, arg: string): Promise<string> {
    if (!arg) return 'Usage: /agent <name> (or /agent default to go back to the project\'s / channel\'s default). See /agents.';
    if (/^(default|reset|none|-)$/i.test(arg)) {
      await this.channels.setChatState(ctx.channelId, ctx.chatId, { agent: null });
      return '✅ New tasks in this chat go to the default agent again (the project\'s, else the channel\'s, else the main lead).';
    }
    const visible = await this.visibleAgents(await this.boundProject(ctx));
    const agent = visible && !visible.has(arg) ? null : await this.agents.get(arg).catch(() => null);
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
    const [state, defAgent, defProvider, activeId, bound] = await Promise.all([
      this.channels.chatState(ctx.channelId, ctx.chatId),
      this.settings.defaultAgent(),
      this.settings.defaultProvider(),
      this.activeTaskId(ctx),
      this.boundProject(ctx),
    ]);
    let active = 'none';
    if (activeId) {
      const t = await this.prisma.task.findUnique({
        where: { id: activeId },
        select: { title: true, status: true },
      });
      active = t ? `«${t.title}» (${t.status})` : '(deleted)';
    }
    return [
      ...(bound ? [`Project: «${bound.name}» (this chat works only with it)`] : []),
      `Active task: ${active}`,
      `Agent: ${state.agent ?? `${bound?.defaultAgent?.trim() || (await this.channels.getRow(ctx.channelId).then((r) => this.channels.defaultAgent(r)).catch(() => undefined)) || defAgent || 'default'} (default)`}`,
      `Model: ${state.model ?? `${defProvider} (default)`}`,
      `Muted: ${state.muted ? 'yes' : 'no'}`,
    ].join('\n');
  }

  /** `/progress on|off` — the live "what the agent is doing" line and the system notes. Off by default: the chat shows only answers. */
  private async progressCmd(ctx: CommandCtx, arg: string): Promise<string> {
    if (arg !== 'on' && arg !== 'off') {
      const st = await this.channels.chatState(ctx.channelId, ctx.chatId);
      return `🛠 Live status lines are ${st.progress ? 'ON' : 'OFF'} in this chat — /progress on or /progress off.\n(Off: the chat carries only answers and anything that needs you.)`;
    }
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { progress: arg === 'on' });
    return arg === 'on' ? '🛠 Live status lines ON — you will see what the agent is doing, and notes like "queued". /progress off to quiet it again.' : '🤫 Live status lines OFF — only answers (and anything that needs you) arrive here.';
  }

  /** `/voice on|off` — also send final answers as a voice message in this chat (text is always sent). */
  private async voiceCmd(ctx: CommandCtx, arg: string): Promise<string> {
    const st = await this.channels.chatState(ctx.channelId, ctx.chatId);
    if (arg !== 'on' && arg !== 'off') {
      return `🔊 Voice replies are ${st.voice ? 'ON' : 'OFF'} in this chat — /voice on or /voice off.${this.voice.ttsReady() ? '' : '\n(Not set up yet: an operator enables it in Settings → Voice.)'}`;
    }
    if (arg === 'on' && !this.voice.ttsReady()) return '🔇 Voice replies are not set up yet — an operator can enable them in Settings → Voice.';
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { voice: arg === 'on' });
    return arg === 'on' ? '🔊 Voice replies ON — final answers also arrive as a voice message (text always comes too). /voice off to stop.' : '🔇 Voice replies OFF — text only.';
  }

  private async mute(ctx: CommandCtx, on: boolean): Promise<string> {
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { muted: on });
    return on
      ? '🔕 Muted routine updates (approvals are still sent). /unmute to restore.'
      : '🔔 Unmuted — you will get task updates again.';
  }

  /** The chat's active task; in a chat bound to a project, one of another project does not count (and is forgotten). */
  private async activeTaskId(ctx: CommandCtx): Promise<string | null> {
    const id = (await this.channels.chatState(ctx.channelId, ctx.chatId)).activeTaskId ?? null;
    if (!id) return null;
    const bound = await this.boundProject(ctx);
    if (!bound) return id;
    const t = await this.prisma.task.findUnique({ where: { id }, select: { projectId: true } }).catch(() => null);
    if (t && t.projectId === bound.id) return id;
    await this.channels.setChatState(ctx.channelId, ctx.chatId, { activeTaskId: null }).catch(() => undefined);
    return null;
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
