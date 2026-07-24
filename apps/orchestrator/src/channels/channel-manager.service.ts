import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { isTerminalStatus, type AgentLogEvent, type TaskStatus } from '@lds/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AgentEventBus, type BusEvent } from '../bus/agent-event-bus';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { MAX_PENDING_FOLLOWUPS, TasksService } from '../tasks/tasks.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { PresenceService } from '../presence/presence.service';
import { ChannelsService } from './channels.service';
import { ChannelCommandService } from './channel-commands.service';
import type { ChannelAdapter, IncomingEvent, MessageButton } from './channel-adapter';

type ChannelRow = Awaited<ReturnType<ChannelsService['getRow']>>;

/** Grace period before an unattended dashboard approval is pushed to channels. */
const ESCALATE_DELAY_MS = 10_000;
/** Minimum gap between edits of a task's live-status message — Telegram
 *  rate-limits rapid edits of the same message; a burst of tool calls just
 *  collapses to the latest line once this window elapses. */
const STATUS_EDIT_MIN_MS = 1500;

/** Final-outcome reaction for a settled task — mirrors the icon already used
 *  in the result message text, plus 'cancelled' (which gets no result message
 *  of its own; the /cancel command/button already confirmed synchronously). */
function reactionIcon(status: TaskStatus): string {
  switch (status) {
    case 'done':
      return '✅';
    case 'blocked':
      return '⛔';
    case 'cancelled':
      return '🛑';
    default:
      return '❌'; // failed, stalled
  }
}

/**
 * Compact (≤~100 char) status line for a task's live-editable channel
 * message — mirrors the web dashboard's live transcript, but far too verbose
 * to forward as-is (tool_result can be an entire file's contents, assistant
 * text can run to paragraphs). Prefers a field that's already short (tool_use
 * text is pre-summarized by the agent runner — "Bash ls -la", not raw JSON)
 * over showing raw content; classifies to null (not shown) for kinds with
 * nothing short worth surfacing — prompt/system/tool_result/result all either
 * duplicate what the human already sees or are unbounded in size.
 */
function compactProcessLine(kind: AgentLogEvent['kind'], text: string): string | null {
  const withIcon = (icon: string) => {
    const s = `${icon} ${text}`;
    return s.length > 100 ? `${s.slice(0, 99).trimEnd()}…` : s;
  };
  switch (kind) {
    case 'tool_use':
      return withIcon('🔧');
    case 'delegation':
      return withIcon('🤝');
    case 'assistant':
      return withIcon('💭');
    case 'stderr':
      return withIcon('⚠️');
    default:
      return null;
  }
}

/**
 * Runtime bridge between channels and the orchestrator:
 *  - outgoing: subscribes to the event bus and posts task status/approvals/results
 *    to the conversation that owns the task (like EventsGateway, for chats);
 *  - incoming: long-polls each enabled channel and turns messages into tasks /
 *    follow-ups and button taps into approval decisions.
 *
 * Authorization is a per-channel allowlist of chat ids (deny by default).
 */
@Injectable()
export class ChannelManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelManagerService.name);
  /** Running polling adapters, keyed by channel id. */
  private readonly adapters = new Map<string, ChannelAdapter>();
  /** Approval id → the channel messages posted for it (to edit on resolve). */
  private readonly approvalMessages = new Map<
    string,
    { channelId: string; chatId: string; messageId: string; taskId: string }[]
  >();
  /** Pending escalation timers, so they can be cleared on shutdown. */
  private readonly escalationTimers = new Set<NodeJS.Timeout>();
  /** taskId → the human's OWN message we ack-reacted to — updated with the
   *  final outcome reaction once the task settles (see reactionIcon). */
  private readonly ackMessages = new Map<string, { channelId: string; chatId: string; messageId: string }>();
  /** taskId → our own "processing…" message, edited in place as compact
   *  process steps stream in (see compactProcessLine). */
  private readonly statusMessages = new Map<string, { channelId: string; chatId: string; messageId: string }>();
  /** taskId → debounce state for status-message edits. */
  private readonly statusEdit = new Map<string, { lastEditAt: number; timer?: NodeJS.Timeout; pending?: string }>();
  /** taskId → attachment filenames already pushed to the channel (see
   *  sendRunAttachments) — in-memory only, reset on restart like the maps
   *  above; worst case a file gets re-sent once after a restart. */
  private readonly sentAttachments = new Map<string, Set<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: AgentEventBus,
    private readonly channels: ChannelsService,
    private readonly tasks: TasksService,
    private readonly approvals: ApprovalsService,
    private readonly attachments: AttachmentsService,
    private readonly commands: ChannelCommandService,
    private readonly presence: PresenceService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.bus.subscribe((e) => void this.dispatchOutgoing(e).catch(() => undefined));
    await this.reload();
  }

  onModuleDestroy(): void {
    for (const a of this.adapters.values()) a.stop();
    this.adapters.clear();
    for (const t of this.escalationTimers) clearTimeout(t);
    this.escalationTimers.clear();
    for (const s of this.statusEdit.values()) if (s.timer) clearTimeout(s.timer);
    this.statusEdit.clear();
  }

  /** (Re)start polling to match the set of enabled channels. Called on CRUD changes. */
  async reload(): Promise<void> {
    for (const a of this.adapters.values()) a.stop();
    this.adapters.clear();
    const rows = await this.channels.list();
    for (const row of rows) {
      if (!row.enabled) continue;
      if (!this.channels.isConfigured(row)) {
        this.logger.warn(`Channel "${row.name}" enabled but not fully configured — skipping`);
        continue;
      }
      try {
        const adapter = this.channels.buildAdapter(row);
        adapter.startPolling((e) => this.handleIncoming(row, e));
        this.adapters.set(row.id, adapter);
        this.logger.log(`Channel "${row.name}" (${row.kind}) polling`);
      } catch (e) {
        this.logger.warn(`Failed to start channel "${row.name}": ${(e as Error).message}`);
      }
    }
  }

  // ---- Outgoing (bus → chat) -----------------------------------------------

  private async dispatchOutgoing(e: BusEvent): Promise<void> {
    switch (e.type) {
      case 'task-status':
        return this.onTaskStatus(e.payload.taskId, e.payload.status);
      case 'agent-log':
        return this.onAgentLog(e.payload);
      case 'approval-created':
        return this.onApprovalCreated(e.payload.approval);
      case 'approval-resolved':
        return this.onApprovalResolved(e.payload.approvalId, e.payload.taskId, e.payload.status);
      case 'task-deleted':
        return this.onTaskDeleted(e.payload.taskId);
      default:
        return;
    }
  }

  /** A live process step — update the task's compact status message (see
   *  compactProcessLine). Most kinds are filtered out before this even runs a
   *  DB query, so this only costs a lookup for the kinds worth narrating. */
  private async onAgentLog(payload: AgentLogEvent): Promise<void> {
    const line = compactProcessLine(payload.kind, payload.text);
    if (!line) return;
    const dest = await this.channels.threadForTask(payload.taskId);
    if (!dest) return; // dashboard-only task, or a subtask (no thread of its own)
    const chatState = await this.prisma.channelChatState.findUnique({
      where: { channelId_chatId: { channelId: dest.channel.id, chatId: dest.externalThreadId } },
      select: { muted: true },
    });
    if (chatState?.muted) return;
    await this.updateStatusLine(dest.channel.id, dest.externalThreadId, payload.taskId, line);
  }

  /** Debounced edit of a task's status message — a burst of tool calls
   *  collapses to whatever the latest line is once STATUS_EDIT_MIN_MS elapses,
   *  rather than firing one Telegram API call per event. */
  private async updateStatusLine(channelId: string, chatId: string, taskId: string, line: string): Promise<void> {
    const state = this.statusEdit.get(taskId) ?? { lastEditAt: 0 };
    this.statusEdit.set(taskId, state);
    state.pending = line;
    if (state.timer) return; // already scheduled — it'll pick up this (or a later) pending line
    const fire = async () => {
      state.timer = undefined;
      const text = state.pending;
      state.pending = undefined;
      state.lastEditAt = Date.now();
      if (text) await this.applyStatusLine(channelId, chatId, taskId, text);
    };
    const elapsed = Date.now() - state.lastEditAt;
    if (elapsed >= STATUS_EDIT_MIN_MS) await fire();
    else state.timer = setTimeout(() => void fire(), STATUS_EDIT_MIN_MS - elapsed);
  }

  /** Edit the existing status message if one's tracked for this task, else
   *  post a fresh one (covers a queued follow-up whose ack message already
   *  said "Queued" — that shouldn't be overwritten once it actually starts). */
  private async applyStatusLine(channelId: string, chatId: string, taskId: string, line: string): Promise<void> {
    const existing = this.statusMessages.get(taskId);
    if (existing) {
      const row = await this.channels.getRow(existing.channelId).catch(() => null);
      if (!row) return;
      const adapter = this.adapters.get(existing.channelId) ?? this.channels.buildAdapter(row);
      await adapter.editMessage?.(existing.chatId, existing.messageId, line).catch(() => undefined);
      return;
    }
    const sent = await this.send(channelId, chatId, line);
    if (sent) this.statusMessages.set(taskId, { channelId, chatId, messageId: sent.messageId });
  }

  /** Task settled — react to the human's message with the final outcome and
   *  stop tracking this run's messages (a fresh run starts its own). */
  private finishRunMessages(taskId: string, status: TaskStatus): void {
    const ack = this.ackMessages.get(taskId);
    this.ackMessages.delete(taskId);
    if (ack) void this.react(ack.channelId, ack.chatId, ack.messageId, reactionIcon(status));
    this.statusMessages.delete(taskId);
    const edit = this.statusEdit.get(taskId);
    if (edit?.timer) clearTimeout(edit.timer);
    this.statusEdit.delete(taskId);
  }

  private async onTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    if (isTerminalStatus(status)) this.finishRunMessages(taskId, status);
    // Keep chats quiet: only final, meaningful outcomes get a result message —
    // no queued/running/needs_approval churn (approvals are posted
    // separately), and 'cancelled' already got its own confirmation
    // synchronously (the /cancel command/button sends it directly).
    if (!['done', 'failed', 'blocked', 'stalled'].includes(status)) return;
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { title: true, prUrl: true, error: true, parentId: true },
    });
    if (!task) return;
    // Subtasks have no thread of their own — surface their result in the parent chat.
    let dest = await this.channels.threadForTask(taskId);
    const prefix = !dest && task.parentId ? '↳ Subtask ' : '';
    if (!dest && task.parentId) dest = await this.channels.threadForTask(task.parentId);
    if (!dest) {
      // No channel of its own (e.g. a dashboard task). For a TOP-LEVEL outcome
      // that needs a human — blocked/stalled/failed — fall back to the default
      // notify channel so the ask isn't lost. Subtasks are excluded: their
      // question escalates to the lead that created them (escalateNeedsInput);
      // notifying the channel too would double-deliver and a human reply would
      // race the lead's own handling of the same question.
      if (!task.parentId && ['blocked', 'stalled', 'failed'].includes(status)) {
        await this.notifyDefaultChannel(taskId, task.title, task.error, status);
      }
      return;
    }

    // Respect a chat's /mute (routine outcomes only; approvals bypass this).
    const chatState = await this.prisma.channelChatState.findUnique({
      where: { channelId_chatId: { channelId: dest.channel.id, chatId: dest.externalThreadId } },
      select: { muted: true },
    });
    if (chatState?.muted) return;

    const icon = reactionIcon(status);
    // Post the agent's actual final answer (the `result` event) — not just a
    // status line. Fall back to the reported summary / title when there is none.
    const body =
      status === 'done'
        ? (await this.latestResult(taskId)) || (await this.channels.summarize(taskId))
        : task.error?.slice(0, 800) || (await this.channels.summarize(taskId));
    const header = status === 'done' ? `${prefix}${icon} «${task.title}»` : `${prefix}${icon} «${task.title}» — ${status}`;
    let text = `${header}\n\n${body}`;
    if (status === 'done' && task.prUrl) text += `\n\n${task.prUrl}`;
    await this.send(dest.channel.id, dest.externalThreadId, text);
    // Also deliver any new attachments the agent produced (screenshots as
    // photos, everything else — reports, archives, etc. — as documents).
    await this.sendRunAttachments(dest.channel.id, dest.externalThreadId, taskId).catch((err) =>
      this.logger.warn(`sendRunAttachments failed: ${(err as Error).message}`),
    );
  }

  /**
   * Fallback escalation for a task with no channel thread (e.g. created in the
   * dashboard): notify the configured default channel/chat so a blocked task's
   * question reaches a human. Unset default = dashboard-only (silent here).
   * Binds the default chat to the task so a reply there routes back as follow_up.
   */
  private async notifyDefaultChannel(
    taskId: string,
    title: string,
    error: string | null,
    status: TaskStatus,
  ): Promise<void> {
    const settings = await this.prisma.appSettings.findUnique({
      where: { id: 'singleton' },
      select: { notifyChannelId: true, notifyChatId: true },
    });
    const channelId = settings?.notifyChannelId;
    const chatId = settings?.notifyChatId;
    if (!channelId || !chatId) return;
    // Respect /mute on the default chat too.
    const chatState = await this.prisma.channelChatState.findUnique({
      where: { channelId_chatId: { channelId, chatId } },
      select: { muted: true },
    });
    if (chatState?.muted) return;

    const icon = status === 'blocked' ? '⛔' : status === 'failed' ? '❌' : '⚠️';
    const body = error?.slice(0, 800) || (await this.channels.summarize(taskId));
    const text =
      `${icon} «${title}» — ${status} (needs input)\n\n${body}\n\n` +
      `Reply here to answer, or open task ${taskId} in the dashboard.`;
    // Make the reply actually route back: inbound text is dispatched via the
    // chat's activeTaskId (handleIncoming), NOT via ChannelThread — so point it
    // at this task. Last escalation wins the chat, matching "reply answers the
    // most recent ask". linkThread additionally binds for outbound updates.
    await this.channels.setChatState(channelId, chatId, { activeTaskId: taskId }).catch(() => undefined);
    await this.channels.linkThread(channelId, taskId, chatId).catch(() => undefined);
    await this.send(channelId, chatId, text);
  }

  /**
   * Send any attachments the task has accumulated that haven't been pushed to
   * the channel yet — covers both tool-result screenshots (written by the
   * agent runner when a tool call returns an image) and files the agent
   * itself copied into $LDS_ATTACHMENTS_DIR per SOUL.md (reports, archives,
   * anything). Images go out via sendImage (as photos); everything else via
   * sendDocument. Dedup by filename per task (sentAttachments) so a file is
   * only ever delivered once, no matter how many times the task later settles
   * again (follow-ups) — capped per call so a burst of new files doesn't spam
   * the chat; anything past the cap just goes out next time it settles.
   */
  private async sendRunAttachments(channelId: string, chatId: string, taskId: string): Promise<void> {
    const all = await this.attachments.list(taskId);
    if (!all.length) return;
    const sent = this.sentAttachments.get(taskId) ?? new Set<string>();
    this.sentAttachments.set(taskId, sent);
    const fresh = all.filter((m) => !sent.has(m.name)).slice(0, 10);
    if (!fresh.length) return;
    const row = await this.channels.getRow(channelId).catch(() => null);
    if (!row) return;
    const adapter = this.adapters.get(channelId) ?? this.channels.buildAdapter(row);
    if (!adapter.sendImage && !adapter.sendDocument) return;
    for (const meta of fresh) {
      sent.add(meta.name);
      try {
        const { path } = await this.attachments.filePath(taskId, meta.name);
        const data = await readFile(path);
        if (meta.mime.startsWith('image/') && adapter.sendImage) {
          await adapter.sendImage(chatId, { data, filename: meta.name });
        } else {
          await adapter.sendDocument?.(chatId, { data, filename: meta.name, mime: meta.mime });
        }
      } catch (err) {
        this.logger.warn(`send attachment ${meta.name} failed: ${(err as Error).message}`);
      }
    }
  }

  /** The agent's most recent final answer (the latest `result` event) for a task. */
  private async latestResult(taskId: string): Promise<string | null> {
    const ev = await this.prisma.agentEvent.findFirst({
      where: { taskId, kind: 'result' },
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      select: { text: true },
    });
    return ev?.text?.trim() || null;
  }

  private async onApprovalCreated(approval: {
    id: string;
    taskId: string;
    summary: string;
    reason: string;
  }): Promise<void> {
    // Channel-originated task → always ask in its own thread.
    const dest = await this.channels.threadForTask(approval.taskId);
    if (dest) {
      const adapter = this.adapters.get(dest.channel.id) ?? this.channels.buildAdapter(dest.channel);
      await adapter
        .sendApproval(dest.externalThreadId, approval)
        .then(({ messageId }) => this.recordApprovalMessage(approval.id, dest.channel.id, dest.externalThreadId, messageId, approval.taskId))
        .catch((err) => this.logger.warn(`sendApproval failed: ${(err as Error).message}`));
      return;
    }
    // Dashboard task (no thread): give the operator a grace period to act in the
    // UI; escalate to channels only if it's still pending and no window is
    // focused (nobody actively watching) after the delay. Track the timer so it
    // can be cancelled on shutdown.
    const timer = setTimeout(() => {
      this.escalationTimers.delete(timer);
      void this.escalateIfUnattended(approval);
    }, ESCALATE_DELAY_MS);
    this.escalationTimers.add(timer);
  }

  private async escalateIfUnattended(approval: {
    id: string;
    taskId: string;
    summary: string;
    reason: string;
  }): Promise<void> {
    if (this.presence.anyoneFocused()) return; // someone is watching the dock
    const row = await this.prisma.approvalRequest.findUnique({
      where: { id: approval.id },
      select: { status: true },
    });
    if (row?.status !== 'pending') return; // already resolved
    await this.broadcastApproval(approval);
  }

  /**
   * Fan an approval out to every enabled channel's allowed chats (used when a
   * dashboard task needs a decision but no one is online to see the UI).
   */
  private async broadcastApproval(approval: {
    id: string;
    taskId: string;
    summary: string;
    reason: string;
  }): Promise<void> {
    const rows = (await this.channels.list()).filter((r) => r.enabled && this.channels.isConfigured(r));
    for (const row of rows) {
      const adapter = this.adapters.get(row.id) ?? this.channels.buildAdapter(row);
      for (const chatId of this.channels.allowedChatIds(row)) {
        await adapter
          .sendApproval(chatId, approval)
          .then(({ messageId }) => this.recordApprovalMessage(approval.id, row.id, chatId, messageId, approval.taskId))
          .catch((err) => this.logger.warn(`broadcast approval failed: ${(err as Error).message}`));
      }
    }
  }

  private recordApprovalMessage(
    approvalId: string,
    channelId: string,
    chatId: string,
    messageId: string,
    taskId: string,
  ): void {
    const list = this.approvalMessages.get(approvalId) ?? [];
    list.push({ channelId, chatId, messageId, taskId });
    this.approvalMessages.set(approvalId, list);
  }

  /**
   * Whether a chat is entitled to decide an approval: it was posted to this chat
   * (tracked), or the approval's task is threaded to this chat (survives a
   * restart that drops the in-memory tracking). Prevents an allowlisted chat
   * from resolving arbitrary approval ids for unrelated tasks.
   */
  private async chatMayDecide(channelId: string, chatId: string, approvalId: string): Promise<boolean> {
    const sent = this.approvalMessages.get(approvalId) ?? [];
    if (sent.some((r) => r.channelId === channelId && r.chatId === chatId)) return true;
    const appr = await this.prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      select: { taskId: true },
    });
    if (!appr) return false;
    const thread = await this.prisma.channelThread.findFirst({
      where: { channelId, externalThreadId: chatId, taskId: appr.taskId },
      select: { id: true },
    });
    return Boolean(thread);
  }

  /** Resolved from anywhere (dock/channel/timeout) → edit the chat message(s):
   *  remove the buttons and show the outcome, so no one taps a stale button. */
  private async onApprovalResolved(approvalId: string, taskId: string, status: string): Promise<void> {
    const refs = this.approvalMessages.get(approvalId);
    this.approvalMessages.delete(approvalId);
    const icon = status === 'approved' ? '✅' : status === 'denied' ? '⛔' : 'ℹ️';
    const outcome = `${icon} Approval ${status}.`;
    if (refs?.length) {
      for (const r of refs) await this.editApprovalMessage(r, outcome);
      return;
    }
    // No tracked message (e.g. after a restart) — fall back to a thread note.
    const dest = await this.channels.threadForTask(taskId);
    if (dest) await this.send(dest.channel.id, dest.externalThreadId, outcome);
  }

  /** A deleted task's pending approvals vanish — neutralize their chat buttons. */
  private async onTaskDeleted(taskId: string): Promise<void> {
    for (const [approvalId, refs] of this.approvalMessages) {
      if (!refs.some((r) => r.taskId === taskId)) continue;
      this.approvalMessages.delete(approvalId);
      for (const r of refs) await this.editApprovalMessage(r, 'ℹ️ Task removed — no longer needed.');
    }
    this.finishRunMessages(taskId, 'cancelled');
    this.sentAttachments.delete(taskId);
  }

  private async editApprovalMessage(
    ref: { channelId: string; chatId: string; messageId: string },
    outcome: string,
  ): Promise<void> {
    const row = await this.channels.getRow(ref.channelId).catch(() => null);
    if (!row) return;
    const adapter = this.adapters.get(ref.channelId) ?? this.channels.buildAdapter(row);
    await adapter
      .resolveApprovalMessage?.(ref.chatId, ref.messageId, outcome)
      .catch((err) => this.logger.warn(`resolveApprovalMessage failed: ${(err as Error).message}`));
  }

  private async send(
    channelId: string,
    chatId: string,
    text: string,
    buttons?: MessageButton[][],
  ): Promise<{ messageId: string } | null> {
    const row = await this.channels.getRow(channelId).catch(() => null);
    if (!row) return null;
    const adapter = this.adapters.get(channelId) ?? this.channels.buildAdapter(row);
    try {
      return await adapter.sendMessage(chatId, text, buttons);
    } catch (err) {
      this.logger.warn(`sendMessage failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Continue the active task with a message, using the SAME server-side
   * pending-follow-up queue the dashboard uses (TasksService.followUp): if the
   * task is still running this just enqueues and confirms with a queue
   * position, rather than dropping the message — it's delivered automatically
   * once the task next settles.
   */
  private async deliverFollowUp(
    channelId: string,
    chatId: string,
    taskId: string,
    text: string,
    attachments?: string[],
    attachedLabel?: string,
    incomingMessageId?: string,
  ): Promise<void> {
    try {
      const result = await this.tasks.followUp(taskId, text, attachments);
      if (incomingMessageId) {
        this.ackMessages.set(taskId, { channelId, chatId, messageId: incomingMessageId });
        void this.react(channelId, chatId, incomingMessageId, result.queued ? '📥' : '👀');
      }
      const prefix = attachedLabel ? `📎 Attached ${attachedLabel} — ` : '';
      const sent = await this.send(
        channelId,
        chatId,
        result.queued
          ? `${prefix}📥 Queued (${result.queueLength}/${MAX_PENDING_FOLLOWUPS}) — will run once the current turn finishes.`
          : `${prefix}↳ Continuing the current task.`,
        [[{ label: '⏹ Cancel', data: `cn:${taskId}` }]],
      );
      // Only an immediately-dispatched run has a live agent to narrate — a
      // queued message has nothing to say until it actually drains, at which
      // point applyStatusLine posts its own fresh status message.
      if (sent && !result.queued) this.statusMessages.set(taskId, { channelId, chatId, messageId: sent.messageId });
    } catch (err) {
      if (incomingMessageId) void this.react(channelId, chatId, incomingMessageId, '⚠️');
      await this.send(channelId, chatId, `⚠️ ${(err as Error).message}`);
    }
  }

  /** Best-effort emoji reaction on an inbound message (bot → user ack), e.g.
   *  👀 "working on it" / 📥 "queued". No-op on transports without support. */
  private async react(channelId: string, chatId: string, messageId: string, emoji: string): Promise<void> {
    const row = await this.channels.getRow(channelId).catch(() => null);
    if (!row) return;
    const adapter = this.adapters.get(channelId) ?? this.channels.buildAdapter(row);
    await adapter.reactToMessage?.(chatId, messageId, emoji).catch(() => undefined);
  }

  /** A tap on a "⏹ Cancel" button — same logic as the /cancel command, just
   *  reachable without knowing the taskId is implicitly "the active one". */
  private async cancelViaButton(channelId: string, chatId: string, taskId: string): Promise<void> {
    const task = await this.tasks.get(taskId).catch(() => null);
    if (!task) {
      await this.send(channelId, chatId, 'Task not found (it may have been deleted).');
      return;
    }
    if (isTerminalStatus(task.status)) {
      await this.send(channelId, chatId, `Task is already ${task.status}.`);
      return;
    }
    await this.tasks.cancel(taskId);
    await this.send(channelId, chatId, '🛑 Cancelled.');
  }

  /**
   * A reaction on a message we sent. Currently only meaningful on a tracked
   * approval message: 👍 approves, 👎 denies — the same effect as tapping the
   * Approve/Deny buttons or typing /approve, just via an emoji. Any other
   * reaction (or one on an untracked message) is silently ignored.
   */
  private async handleReaction(
    channelId: string,
    chatId: string,
    messageId: string,
    emoji: string,
    channelKind: string,
    who: string,
  ): Promise<void> {
    if (emoji !== '👍' && emoji !== '👎') return;
    let approvalId: string | null = null;
    for (const [id, refs] of this.approvalMessages) {
      if (refs.some((r) => r.channelId === channelId && r.chatId === chatId && r.messageId === messageId)) {
        approvalId = id;
        break;
      }
    }
    if (!approvalId) return; // not a message we track reactions for
    const decision = emoji === '👍' ? 'approve' : 'deny';
    await this.approvals
      .decide(approvalId, decision, { displayName: `${channelKind}:${who}` })
      .catch((err) => this.logger.warn(`reaction-decide failed: ${(err as Error).message}`));
  }

  // ---- Incoming (chat → orchestrator) --------------------------------------

  private async handleIncoming(row: ChannelRow, e: IncomingEvent): Promise<void> {
    const channelId = row.id;
    // Authorize: only allowlisted chats may drive the channel (deny by default).
    if (!this.channels.allowedChatIds(row).includes(e.chatId)) {
      this.logger.warn(`Ignoring ${e.type} from unauthorized chat ${e.chatId}`);
      return;
    }

    if (e.type === 'approval') {
      // Ownership check: this chat may only decide an approval that was actually
      // sent to it (its task's thread, or a broadcast this chat received) — not
      // any approval id it happens to know.
      if (!(await this.chatMayDecide(channelId, e.chatId, e.approvalId))) {
        this.logger.warn(`Chat ${e.chatId} not allowed to decide approval ${e.approvalId}`);
        return;
      }
      await this.approvals
        .decide(e.approvalId, e.decision, { displayName: `${row.kind}:${e.userName ?? e.userId}` })
        .catch((err) => this.logger.warn(`decide failed: ${(err as Error).message}`));
      return;
    }

    if (e.type === 'attachment') {
      await this.handleAttachment(row, e).catch((err) =>
        this.send(channelId, e.chatId, `⚠️ ${(err as Error).message}`),
      );
      return;
    }

    if (e.type === 'task-switch') {
      const ctx = { channelId, chatId: e.chatId, userId: e.userId, kind: row.kind };
      const reply = await this.commands
        .switchToTaskById(ctx, e.taskId)
        .catch((err) => `⚠️ ${(err as Error).message}`);
      await this.send(channelId, e.chatId, reply);
      return;
    }

    if (e.type === 'cancel') {
      await this.cancelViaButton(channelId, e.chatId, e.taskId);
      return;
    }

    if (e.type === 'reaction') {
      await this.handleReaction(channelId, e.chatId, e.messageId, e.emoji, row.kind, e.userName ?? e.userId);
      return;
    }

    const ctx = { channelId, chatId: e.chatId, userId: e.userId, kind: row.kind };

    // Slash commands manage the conversation (new-task, tasks, task, clear, …).
    if (this.commands.isCommand(e.text)) {
      const reply = await this.commands
        .handle(ctx, e.text)
        .catch((err) => `⚠️ ${(err as Error).message}`);
      if (typeof reply === 'string') {
        await this.send(channelId, e.chatId, reply);
      } else {
        await this.send(channelId, e.chatId, reply.text, reply.buttons);
      }
      return;
    }

    // Plain message → continue the active task; if none (or it's gone), start one.
    const state = await this.channels.chatState(channelId, e.chatId);
    if (state.activeTaskId) {
      const task = await this.prisma.task.findUnique({
        where: { id: state.activeTaskId },
        select: { status: true },
      });
      if (task) {
        await this.deliverFollowUp(channelId, e.chatId, state.activeTaskId, e.text, undefined, undefined, e.messageId);
        return;
      }
      // active task was deleted — fall through to create a fresh one
    }
    const created = await this.commands
      .newTask(ctx, e.text)
      .catch((err) => ({ text: `⚠️ ${(err as Error).message}`, taskId: null }));
    if (e.messageId && created.taskId) {
      // A brand-new task — track its ack message so the final outcome updates
      // this reaction too (👀 now, ✅/❌/⛔ once it settles).
      this.ackMessages.set(created.taskId, { channelId, chatId: e.chatId, messageId: e.messageId });
      void this.react(channelId, e.chatId, e.messageId, '👀');
    } else if (e.messageId && created.text.startsWith('⚠️')) {
      void this.react(channelId, e.chatId, e.messageId, '⚠️');
    }
    await this.send(channelId, e.chatId, created.text);
  }

  /** A photo/document from the chat → attach to the active task (or start one). */
  private async handleAttachment(
    row: ChannelRow,
    e: Extract<IncomingEvent, { type: 'attachment' }>,
  ): Promise<void> {
    const channelId = row.id;
    const state = await this.channels.chatState(channelId, e.chatId);
    const buf = Buffer.from(e.data, 'base64');
    const caption = e.caption?.trim() || 'Review the attached file.';

    if (state.activeTaskId) {
      const task = await this.prisma.task.findUnique({
        where: { id: state.activeTaskId },
        select: { status: true },
      });
      if (task) {
        const meta = await this.attachments.save(state.activeTaskId, e.fileName, Readable.from(buf));
        await this.deliverFollowUp(
          channelId,
          e.chatId,
          state.activeTaskId,
          caption,
          [meta.name],
          meta.name,
          e.messageId,
        );
        return;
      }
    }
    // No live active task → start a new one with the file (deferred autostart so
    // the run doesn't read the attachments dir before the file lands).
    const created = await this.tasks.create({
      prompt: caption,
      agentName: state.agent ?? undefined,
      provider: state.model ?? undefined,
      createdByChannel: `${row.kind}:${e.userId}`,
      autostart: false,
    });
    const meta = await this.attachments.save(created.id, e.fileName, Readable.from(buf));
    await this.tasks.start(created.id, [meta.name]);
    await this.channels.linkThread(channelId, created.id, e.chatId);
    await this.channels.setChatState(channelId, e.chatId, { activeTaskId: created.id });
    if (e.messageId) {
      this.ackMessages.set(created.id, { channelId, chatId: e.chatId, messageId: e.messageId });
      void this.react(channelId, e.chatId, e.messageId, '👀');
    }
    await this.send(channelId, e.chatId, `📎 New task «${created.title}» with ${meta.name}. Updates will appear here.`);
  }
}
