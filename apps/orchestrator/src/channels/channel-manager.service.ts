import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { REQUEST_SECRET_TOOL, isTerminalStatus, type AgentLogEvent, type AgentQuestion, type TaskStatus } from '@lds/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AgentEventBus, type BusEvent } from '../bus/agent-event-bus';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { MAX_PENDING_FOLLOWUPS, TasksService } from '../tasks/tasks.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { QuestionsService } from '../questions/questions.service';
import { resolveAnswer } from '../questions/questions-core';
import { isDoneMessage } from '../tasks/done-intent';
import { AttachmentsService } from '../attachments/attachments.service';
import { PresenceService } from '../presence/presence.service';
import { ChannelsService, adapterSignature } from './channels.service';
import { COMMAND_MENU } from './command-menu';
import { ChannelCommandService } from './channel-commands.service';
import { PairingService } from './pairing.service';
import { VoiceService } from '../voice/voice.service';
import { MAX_AUDIO_SECONDS } from '../voice/voice-core';
import { SecretLinksService, secretLabel } from '../approvals/secret-links.service';
import { ChannelGateway, type MessageRef } from './channel-gateway.service';
import { ChatDestinationService } from './chat-destination.service';
import { approvalOutcome, compactProcessLine, questionButtons, questionOutcome, questionText, reactionIcon, resultMessage, withQuote } from './chat-format';
import { resolveTarget, spokenToTask, type RoutingFacts } from './inbound-routing';
import type { IncomingEvent } from './channel-adapter';

type ChannelRow = Awaited<ReturnType<ChannelsService['getRow']>>;

/** The part of an approval a chat message needs. */
interface ApprovalMsg {
  id: string;
  taskId: string;
  summary: string;
  reason: string;
  toolName?: string;
  toolInput?: unknown;
}

/** Grace period before an unattended dashboard approval is pushed to channels. */
const ESCALATE_DELAY_MS = 10_000;
/** How often pending approvals/questions that reached no chat are looked for (the timers above live in memory only). */
const SWEEP_MS = 30_000;
/** Minimum gap between edits of a task's live-status message — Telegram
 *  rate-limits rapid edits of the same message; a burst of tool calls just
 *  collapses to the latest line once this window elapses. */
const STATUS_EDIT_MIN_MS = 1500;
/** How long a reload waits for a replaced adapter to finish the update it is handling before the new one starts. */
const STOP_WAIT_MS = 5000;

/**
 * Runtime bridge between channels and the orchestrator:
 *  - outgoing: subscribes to the event bus and posts task status/approvals/results
 *    to the conversation that owns the task (like EventsGateway, for chats);
 *  - incoming: long-polls each enabled channel and turns messages into tasks /
 *    follow-ups and button taps into approval decisions.
 *
 * Authorization is a per-channel allowlist of chat ids (deny by default).
 * Transport primitives live in ChannelGateway, "which chat does this task speak in" in ChatDestinationService; which
 * chat message stands for which approval / question / ack / delivered attachment is in ChannelMessageLink (survives restarts).
 */
@Injectable()
export class ChannelManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelManagerService.name);
  /** channelId → the row signature its running adapter was built from (reload rebuilds only what changed). */
  private readonly adapterSignatures = new Map<string, string>();
  /** Pending escalation timers, so they can be cleared on shutdown. */
  private readonly escalationTimers = new Set<NodeJS.Timeout>();
  /** taskId → our own "processing…" message, edited in place as compact
   *  process steps stream in (see compactProcessLine). Live-run state only. */
  private readonly statusMessages = new Map<string, MessageRef>();
  /** taskId → debounce state for status-message edits. */
  private readonly statusEdit = new Map<string, { lastEditAt: number; timer?: NodeJS.Timeout; pending?: string }>();
  /** channelId → hash of the command menu last published (agent commands change as agents come and go). */
  private readonly menuHash = new Map<string, string>();
  private menuTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;
  /** taskId → the repeating "typing…" status shown in the chat while the agent works. */
  private readonly activity = new Map<string, { timer: NodeJS.Timeout; stopAt: number }>();
  /** Multiple-choice ticks per question (kept in memory; a restart just starts the ticking over). */
  private readonly questionPicks = new Map<string, Set<number>>();
  /** channelId → the newest inbound cursor not yet written to the channel's config. */
  private readonly pendingOffset = new Map<string, number>();
  private readonly offsetWriting = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: AgentEventBus,
    private readonly channels: ChannelsService,
    private readonly tasks: TasksService,
    private readonly approvals: ApprovalsService,
    private readonly questions: QuestionsService,
    private readonly attachments: AttachmentsService,
    private readonly commands: ChannelCommandService,
    private readonly presence: PresenceService,
    private readonly pairing: PairingService,
    private readonly secretLinks: SecretLinksService,
    private readonly voice: VoiceService,
    private readonly gateway: ChannelGateway,
    private readonly dest: ChatDestinationService,
  ) {}

  async onModuleInit(): Promise<void> {
    void this.channels.pruneMessageLinks();
    this.bus.subscribe((e) => void this.dispatchOutgoing(e).catch(() => undefined));
    await this.reload();
    this.menuTimer = setInterval(() => void this.refreshCommandMenus(), 3 * 60_000);
    this.menuTimer.unref?.();
    this.sweepTimer = setInterval(() => void this.sweepEscalations().catch((e) => this.logger.warn(`escalation sweep failed: ${(e as Error).message}`)), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.menuTimer) clearInterval(this.menuTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const a of this.activity.values()) clearInterval(a.timer);
    this.activity.clear();
    for (const a of this.gateway.adapters.values()) void a.stop().catch(() => undefined);
    this.gateway.adapters.clear();
    this.adapterSignatures.clear();
    for (const t of this.escalationTimers) clearTimeout(t);
    this.escalationTimers.clear();
    for (const s of this.statusEdit.values()) if (s.timer) clearTimeout(s.timer);
    this.statusEdit.clear();
  }

  /**
   * (Re)start polling to match the set of enabled channels. Called on CRUD changes. Only channels that were added,
   * removed, switched or edited are touched: the others keep polling undisturbed (a reload used to restart every
   * adapter from cursor 0, replaying the last batch of updates — duplicate tasks and approvals).
   */
  async reload(): Promise<void> {
    const rows = await this.channels.list();
    const wanted = new Map<string, ChannelRow>();
    for (const row of rows) {
      if (!row.enabled) continue;
      if (!this.channels.isConfigured(row)) {
        this.logger.warn(`Channel "${row.name}" enabled but not fully configured — skipping`);
        continue;
      }
      wanted.set(row.id, row);
    }
    for (const [id, signature] of [...this.adapterSignatures]) {
      const row = wanted.get(id);
      if (row && adapterSignature(row) === signature) continue;
      this.adapterSignatures.delete(id);
      this.menuHash.delete(id);
      const adapter = this.gateway.adapters.get(id);
      this.gateway.adapters.delete(id);
      // let it finish the update it is handling (its cursor is persisted per update), so the replacement does not see it twice
      if (adapter) await Promise.race([adapter.stop(), delay(STOP_WAIT_MS)]).catch(() => undefined);
    }
    for (const row of wanted.values()) {
      if (this.adapterSignatures.has(row.id)) continue;
      try {
        const adapter = this.channels.buildAdapter(row);
        adapter.startPolling((e) => this.handleIncoming(row, e), { onOffset: (last) => this.rememberOffset(row.id, last) });
        this.gateway.adapters.set(row.id, adapter);
        this.adapterSignatures.set(row.id, adapterSignature(row));
        this.logger.log(`Channel "${row.name}" (${row.kind}) polling`);
      } catch (e) {
        this.logger.warn(`Failed to start channel "${row.name}": ${(e as Error).message}`);
      }
    }
    void this.refreshCommandMenus();
  }

  /** Persist the inbound cursor (one write at a time per channel; a burst collapses to the newest value). */
  private rememberOffset(channelId: string, lastUpdateId: number): void {
    this.pendingOffset.set(channelId, lastUpdateId);
    if (this.offsetWriting.has(channelId)) return;
    this.offsetWriting.add(channelId);
    void (async () => {
      try {
        while (this.pendingOffset.has(channelId)) {
          const v = this.pendingOffset.get(channelId)!;
          this.pendingOffset.delete(channelId);
          await this.channels.setRuntimeConfig(channelId, { lastUpdateId: v }).catch((e) => this.logger.warn(`could not save the inbound cursor: ${(e as Error).message}`));
        }
      } finally {
        this.offsetWriting.delete(channelId);
      }
    })();
  }

  /** Publish the command menu (built-ins + one command per agent) to every channel that has one. Skips an unchanged menu. */
  private async refreshCommandMenus(): Promise<void> {
    const extra = await this.commands.agentCommands().catch(() => []);
    const list = [...COMMAND_MENU.map((c) => ({ command: c.command, description: c.description })), ...extra];
    const hash = JSON.stringify(list);
    for (const [id, adapter] of this.gateway.adapters) {
      if (!adapter.setCommands || this.menuHash.get(id) === hash) continue;
      this.menuHash.set(id, hash);
      await adapter.setCommands(list).catch((e) => {
        this.menuHash.delete(id); // try again at the next refresh (every 3 min)
        this.logger.warn(`Publishing the command menu failed (will retry): ${(e as Error).message}`);
      });
    }
  }

  // ---- Outgoing (bus → chat) -----------------------------------------------

  private async dispatchOutgoing(e: BusEvent): Promise<void> {
    switch (e.type) {
      case 'task-status':
        void this.onTaskActivity(e.payload.taskId, e.payload.status).catch(() => undefined);
        return this.onTaskStatus(e.payload.taskId, e.payload.status);
      case 'agent-log':
        return this.onAgentLog(e.payload);
      case 'question-created':
        return this.onQuestionCreated(e.payload.question);
      case 'question-resolved':
        return this.onQuestionResolved(e.payload.question);
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

  /** While a task RUNS, its chat shows "typing…"; it stops when the task settles or waits for a human. */
  private async onTaskActivity(taskId: string, status: TaskStatus): Promise<void> {
    if (status !== 'running') {
      const a = this.activity.get(taskId);
      if (a) {
        clearInterval(a.timer);
        this.activity.delete(taskId);
      }
      return;
    }
    if (this.activity.has(taskId)) return;
    // a subtask has no thread of its own: its work shows in the parent's chat
    const dest = await this.dest.destForTask(taskId);
    if (!dest) return;
    if ((await this.dest.prefs(dest.channelId, dest.chatId)).muted || this.activity.has(taskId)) return;
    this.activity.set(taskId, this.gateway.repeatActivity(dest.channelId, dest.chatId, 'typing'));
  }

  /** A live process step — update the task's compact status message (see
   *  compactProcessLine). Most kinds are filtered out before this even runs a
   *  DB query, so this only costs a lookup for the kinds worth narrating. */
  private async onAgentLog(payload: AgentLogEvent): Promise<void> {
    // a message in a discussion between agents: posted to the chat as it is said
    if (payload.kind === 'discussion' && payload.speaker) {
      const d = await this.dest.destForTask(payload.taskId);
      if (d?.own && !(await this.dest.prefs(d.channelId, d.chatId)).muted) {
        await this.gateway.send(d.channelId, d.chatId, payload.speaker === 'system' ? payload.text : `🗣 ${payload.speaker}:\n${payload.text}`, undefined, payload.taskId);
      }
      return;
    }
    // pictures the agent chose to show (show_images): sent at once, as a photo or an album with the caption
    if (payload.kind === 'assistant' && payload.attachments?.length) {
      await this.deliverShown(payload.taskId, payload.attachments, payload.text).catch((e) => this.logger.warn(`show_images delivery failed: ${(e as Error).message}`));
      return; // the caption went out with the pictures — no second "💭 …" status line for it
    }
    const line = compactProcessLine(payload.kind, payload.text);
    if (!line) return;
    const dest = await this.dest.destForTask(payload.taskId);
    if (!dest?.own) return; // dashboard-only task, or a subtask (no thread of its own: its steps are not narrated in the parent chat)
    // The live "what the agent is doing" line is system information: only for chats that asked for it (/progress on).
    const prefs = await this.dest.prefs(dest.channelId, dest.chatId);
    if (prefs.muted || !prefs.progress) return;
    await this.updateStatusLine(dest.channelId, dest.chatId, payload.taskId, line);
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
      await this.gateway.edit(existing, line);
      return;
    }
    const sent = await this.gateway.send(channelId, chatId, line, undefined, taskId);
    if (sent) this.statusMessages.set(taskId, { channelId, chatId, messageId: sent.messageId });
  }

  /** Task settled — react to the human's message with the final outcome and
   *  stop tracking this run's messages (a fresh run starts its own). */
  private async finishRunMessages(taskId: string, status: TaskStatus): Promise<void> {
    const acks = await this.channels.messagesFor('ack', taskId);
    if (acks.length) {
      await this.channels.unlinkRef('ack', taskId);
      for (const a of acks) void this.gateway.react(a.channelId, a.chatId, a.messageId, reactionIcon(status));
    }
    this.statusMessages.delete(taskId);
    const edit = this.statusEdit.get(taskId);
    if (edit?.timer) clearTimeout(edit.timer);
    this.statusEdit.delete(taskId);
  }

  /** The person's own message that started / continued a task: reacted to now (👀 / 📥) and again with the outcome once it settles. */
  private async setAck(taskId: string, channelId: string, chatId: string, messageId: string): Promise<void> {
    await this.channels.unlinkRef('ack', taskId);
    await this.channels.linkMessage(channelId, chatId, messageId, taskId, { kind: 'ack', refId: taskId });
  }

  private async onTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    if (isTerminalStatus(status)) await this.finishRunMessages(taskId, status);
    if (status === 'cancelled') await this.neutralizeApprovalMessages(taskId);
    // Keep chats quiet: only final, meaningful outcomes get a result message —
    // no queued/running/needs_approval churn (approvals are posted
    // separately), and 'cancelled' already got its own confirmation
    // synchronously (the /cancel command/button sends it directly).
    if (!['review', 'done', 'failed', 'blocked', 'stalled'].includes(status)) return;
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { title: true, prUrl: true, error: true, parentId: true },
    });
    if (!task) return;
    // `done` of a top-level task is the PERSON's confirmation (already answered on the spot): nothing more to post. A subtask's `done` is its lead's result.
    if (status === 'done' && !task.parentId) return;
    // Subtasks have no thread of their own — surface their result in the parent chat.
    const dest = await this.dest.destForTask(taskId);
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
    const prefix = dest.own ? '' : '↳ Subtask ';

    // Respect a chat's /mute (routine outcomes only; approvals bypass this).
    const prefs = await this.dest.prefs(dest.channelId, dest.chatId);
    if (prefs.muted) return;

    // A top-level task that is blocked on the person has just asked them something in this chat: their next plain message
    // answers IT (the last ask wins the chat), not whatever task happened to be active before — the same rule the default-channel
    // escalation uses. Replying (quoting) to any message still addresses that message's task.
    if (status === 'blocked' && !task.parentId) {
      await this.channels.setChatState(dest.channelId, dest.chatId, { activeTaskId: taskId }).catch(() => undefined);
    }

    // The agent's work is finished (a top-level task: waiting for the person to accept it; a subtask: done for its lead).
    const answered = status === 'review' || status === 'done';
    // Post the agent's actual final answer (the `result` event) — not just a
    // status line. Fall back to the reported summary / title when there is none.
    // a discussion between agents has no single answer: its messages were already posted one by one
    // No "done" button in chats: the person confirms by writing "done" (or /done) — see isDoneMessage. (Old messages' md: buttons still work.)
    if (answered && (await this.endedWithDiscussion(taskId))) {
      await this.gateway.send(dest.channelId, dest.chatId, '✅ The discussion is over. Write here to continue it — or write “done” to close it.', undefined, taskId);
      return;
    }
    const body = answered ? (await this.latestResult(taskId)) || (await this.channels.summarize(taskId)) : task.error?.slice(0, 800) || (await this.channels.summarize(taskId));
    // Replying to any of these messages addresses the task that sent it.
    const text = resultMessage({ status, title: task.title, body, prefix, prUrl: task.prUrl, progress: prefs.progress });
    await this.gateway.send(dest.channelId, dest.chatId, text, undefined, taskId);
    if (answered && prefs.voice) await this.speakReply(dest.channelId, dest.chatId, body);
    // Also deliver any new attachments the agent produced (screenshots as
    // photos, everything else — reports, archives, etc. — as documents).
    await this.sendRunAttachments(dest.channelId, dest.chatId, taskId).catch((err) =>
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
    if ((await this.dest.prefs(channelId, chatId)).muted) return;

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
    await this.gateway.send(channelId, chatId, text, undefined, taskId);
  }

  /** Send pictures an agent showed (single or album) to the task's chat right away and remember them as sent. */
  private async deliverShown(taskId: string, names: string[], caption: string): Promise<void> {
    const dest = await this.dest.destForTask(taskId);
    if (!dest?.own) return;
    if ((await this.dest.prefs(dest.channelId, dest.chatId)).muted) return;
    const metas = (await this.attachments.list(taskId)).filter((m) => names.includes(m.name));
    for (const m of metas) await this.channels.markAttachmentSent(dest.channelId, dest.chatId, taskId, m.name);
    await this.sendPictures(dest.channelId, dest.chatId, taskId, metas, caption.trim());
  }

  /** Pictures as ONE album when the transport can (2–10), else one by one; the caption goes on the first. */
  private async sendPictures(channelId: string, chatId: string, taskId: string, metas: { name: string; mime: string }[], caption: string): Promise<void> {
    const adapter = this.gateway.adapterFor(channelId);
    if (!adapter) return;
    const files: { data: Buffer; filename: string }[] = [];
    for (const m of metas) {
      const { path } = await this.attachments.filePath(taskId, m.name);
      files.push({ data: await readFile(path), filename: m.name });
    }
    if (!files.length) return;
    await this.gateway.withActivity(channelId, chatId, 'upload_photo', async () => {
      if (files.length >= 2 && adapter.sendImages) {
        for (let i = 0; i < files.length; i += 10) {
          const batch = files.slice(i, i + 10);
          if (batch.length >= 2) await adapter.sendImages!(chatId, batch, i === 0 ? caption : undefined);
          else await adapter.sendImage?.(chatId, batch[0]!, i === 0 ? caption : undefined);
        }
      } else {
        for (let i = 0; i < files.length; i++) await adapter.sendImage?.(chatId, files[i]!, i === 0 ? caption : undefined);
      }
    });
  }

  /**
   * Send any attachments the task has accumulated that haven't been pushed to
   * the channel yet — covers both tool-result screenshots (written by the
   * agent runner when a tool call returns an image) and files the agent
   * itself copied into $LDS_ATTACHMENTS_DIR per SOUL.md (reports, archives,
   * anything). Images go out via sendImage (as photos); everything else via
   * sendDocument. Dedup by filename per task (ChannelMessageLink kind=attachment,
   * so a restart does not resend) — a file is only ever delivered once, no matter
   * how many times the task later settles again (follow-ups) — capped per call so
   * a burst of new files doesn't spam the chat; anything past the cap just goes
   * out next time it settles.
   */
  private async sendRunAttachments(channelId: string, chatId: string, taskId: string): Promise<void> {
    const all = await this.attachments.list(taskId);
    if (!all.length) return;
    const sent = await this.channels.sentAttachments(taskId);
    const fresh = all.filter((m) => !sent.has(m.name)).slice(0, 10);
    if (!fresh.length) return;
    const adapter = this.gateway.adapterFor(channelId);
    if (!adapter || (!adapter.sendImage && !adapter.sendDocument)) return;
    const mark = (name: string) => this.channels.markAttachmentSent(channelId, chatId, taskId, name);
    // pictures go out together as an album (2–10), everything else one by one
    const pics = fresh.filter((m) => m.mime.startsWith('image/'));
    if (pics.length >= 2 && adapter.sendImages) {
      for (const m of pics) await mark(m.name);
      await this.sendPictures(channelId, chatId, taskId, pics, '').catch((err) => this.logger.warn(`send album failed: ${(err as Error).message}`));
    }
    for (const meta of fresh) {
      if (pics.length >= 2 && adapter.sendImages && meta.mime.startsWith('image/')) continue;
      await mark(meta.name);
      try {
        const { path } = await this.attachments.filePath(taskId, meta.name);
        const data = await readFile(path);
        if (meta.mime.startsWith('image/') && adapter.sendImage) {
          await this.gateway.withActivity(channelId, chatId, 'upload_photo', () => adapter.sendImage!(chatId, { data, filename: meta.name }));
        } else {
          await this.gateway.withActivity(channelId, chatId, meta.mime.startsWith('video/') ? 'upload_video' : 'upload_document', async () => adapter.sendDocument?.(chatId, { data, filename: meta.name, mime: meta.mime }));
        }
      } catch (err) {
        this.logger.warn(`send attachment ${meta.name} failed: ${(err as Error).message}`);
      }
    }
  }

  /** The newest thing said in the task was a discussion message (no later `result`). */
  private async endedWithDiscussion(taskId: string): Promise<boolean> {
    const ev = await this.prisma.agentEvent.findFirst({ where: { taskId, kind: { in: ['discussion', 'result'] } }, orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }], select: { kind: true } });
    return ev?.kind === 'discussion';
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

  // ---- questions (ask_user) ----

  private async onQuestionCreated(q: AgentQuestion): Promise<void> {
    // a subtask has none of its own, so its asks go to the parent's chat (like its status does)
    const dest = await this.dest.destForTask(q.taskId);
    if (dest) {
      await this.postQuestion(dest.channelId, dest.chatId, q);
      return;
    }
    // A dashboard task: give whoever is looking at the page a moment, then ask in the chats if it is still open and nobody is watching.
    const timer = setTimeout(() => {
      this.escalationTimers.delete(timer);
      void this.escalateQuestion(q).catch((err) => this.logger.warn(`question escalation failed: ${(err as Error).message}`));
    }, ESCALATE_DELAY_MS);
    this.escalationTimers.add(timer);
  }

  /** Ask in every allowed chat of every enabled channel — unless someone is watching the dashboard or it has been answered meanwhile. */
  private async escalateQuestion(q: AgentQuestion): Promise<void> {
    if (this.presence.anyoneFocused()) return;
    const row = await this.prisma.agentQuestion.findUnique({ where: { id: q.id }, select: { status: true } });
    if (row?.status !== 'pending') return;
    for (const ch of (await this.channels.list()).filter((r) => r.enabled && this.channels.isConfigured(r))) {
      for (const chatId of this.channels.allowedChatIds(ch)) await this.postQuestion(ch.id, chatId, q);
    }
  }

  /** Post a question with one button per option; the person can also just reply with text. */
  private async postQuestion(channelId: string, chatId: string, q: AgentQuestion): Promise<void> {
    const adapter = this.gateway.adapterFor(channelId);
    if (!adapter) return;
    if (q.image && adapter.sendImage) {
      const data = await readFile(q.image).catch(() => null);
      if (data) await adapter.sendImage(chatId, { data, filename: basename(q.image) }).catch(() => undefined);
    }
    const buttons = q.options.length ? questionButtons(q, new Set()) : undefined;
    await this.gateway.send(channelId, chatId, questionText(q), buttons, q.taskId, { kind: 'question', refId: q.id });
  }

  /** Answered / timed out / cancelled (from anywhere): drop the buttons and show how it ended, so nobody taps a stale one. */
  private async onQuestionResolved(q: AgentQuestion): Promise<void> {
    this.questionPicks.delete(q.id);
    const refs = await this.channels.messagesFor('question', q.id);
    if (!refs.length) return;
    const outcome = questionOutcome(q);
    for (const r of refs) await this.gateway.resolveMessage(r, outcome);
  }

  /** Whether this chat may answer the question: it got the message (also after a restart), or the task is threaded to the chat. */
  private async chatMayAnswer(channelId: string, chatId: string, q: AgentQuestion): Promise<boolean> {
    if (await this.channels.chatHasMessageFor(channelId, chatId, 'question', q.id)) return true;
    return Boolean(await this.prisma.channelThread.findFirst({ where: { channelId, externalThreadId: chatId, taskId: q.taskId }, select: { id: true } }));
  }

  // ---- approvals ----

  private async onApprovalCreated(approval: ApprovalMsg): Promise<void> {
    // Channel-originated task → always ask in its own thread (a subtask: in its parent's).
    const dest = await this.dest.destForTask(approval.taskId);
    if (dest) {
      await this.postApproval(dest.channelId, dest.chatId, approval);
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

  private async escalateIfUnattended(approval: ApprovalMsg): Promise<void> {
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
  private async broadcastApproval(approval: ApprovalMsg): Promise<void> {
    const rows = (await this.channels.list()).filter((r) => r.enabled && this.channels.isConfigured(r));
    for (const row of rows) {
      for (const chatId of this.channels.allowedChatIds(row)) await this.postApproval(row.id, chatId, approval);
    }
  }

  /**
   * The in-memory escalation timers die with the process: every SWEEP_MS, a pending approval / question older than the
   * grace period that reached NO chat yet is posted — to its task's chat when it has one (the first post failed), else
   * through the unattended-dashboard path.
   */
  private async sweepEscalations(): Promise<void> {
    if (this.sweeping || !this.gateway.adapters.size) return;
    this.sweeping = true;
    try {
      const since = new Date(Date.now() - ESCALATE_DELAY_MS);
      const approvals = await this.prisma.approvalRequest.findMany({
        where: { status: 'pending', createdAt: { lt: since } },
        select: { id: true, taskId: true, summary: true, reason: true, toolName: true, toolInput: true },
        take: 20,
      });
      for (const a of approvals) {
        if (await this.anyMessageFor('approval', a.id)) continue;
        const dest = await this.dest.destForTask(a.taskId);
        if (dest) await this.postApproval(dest.channelId, dest.chatId, a);
        else await this.escalateIfUnattended(a);
      }
      const questions = (await this.questions.list('pending')).filter((q) => new Date(q.createdAt) < since);
      for (const q of questions) {
        if (await this.anyMessageFor('question', q.id)) continue;
        const dest = await this.dest.destForTask(q.taskId);
        if (dest) await this.postQuestion(dest.channelId, dest.chatId, q);
        else await this.escalateQuestion(q);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async anyMessageFor(kind: 'approval' | 'question', refId: string): Promise<boolean> {
    return Boolean(await this.prisma.channelMessageLink.findFirst({ where: { kind, refId }, select: { id: true } }));
  }

  /**
   * Whether a chat is entitled to decide an approval: it was posted to this chat
   * (ChannelMessageLink — survives a restart), or the approval's task is threaded
   * to this chat. Prevents an allowlisted chat from resolving arbitrary approval
   * ids for unrelated tasks.
   */
  private async chatMayDecide(channelId: string, chatId: string, approvalId: string): Promise<boolean> {
    if (await this.channels.chatHasMessageFor(channelId, chatId, 'approval', approvalId)) return true;
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
    const outcome = approvalOutcome(status);
    const refs = await this.channels.messagesFor('approval', approvalId);
    if (refs.length) {
      for (const r of refs) await this.gateway.resolveMessage(r, outcome);
      return;
    }
    // No message stood for it (it never reached a chat) — fall back to a thread note.
    const dest = await this.dest.destForTask(taskId);
    if (dest) await this.gateway.send(dest.channelId, dest.chatId, outcome);
  }

  /** A deleted task: its message links go with it (cascade; a live task is cancelled first, which neutralizes its approval buttons). */
  private async onTaskDeleted(taskId: string): Promise<void> {
    await this.neutralizeApprovalMessages(taskId);
    await this.finishRunMessages(taskId, 'cancelled');
  }

  /** A cancelled / deleted task's pending approvals are moot — take the buttons off their chat messages. */
  private async neutralizeApprovalMessages(taskId: string): Promise<void> {
    const links = await this.prisma.channelMessageLink.findMany({ where: { taskId, kind: 'approval' }, select: { channelId: true, chatId: true, messageId: true, refId: true } }).catch(() => []);
    if (!links.length) return;
    const pending = new Set((await this.prisma.approvalRequest.findMany({ where: { taskId, status: 'pending' }, select: { id: true } })).map((a) => a.id));
    for (const l of links) {
      if (!l.refId || !pending.has(l.refId)) continue;
      await this.gateway.resolveMessage(l, 'ℹ️ Task cancelled — no longer needed.');
    }
  }

  /**
   * Post an approval to a chat. A secret request gets NO approve button (a plain "Approve" cannot supply a key): the message
   * explains what is needed and, when a public address is configured, carries a one-time link to a secure page. The key is
   * never typed into the chat. The message is remembered as standing for the approval (buttons / 👍 keep working after a restart).
   */
  private async postApproval(channelId: string, chatId: string, approval: ApprovalMsg): Promise<void> {
    const ref = { kind: 'approval' as const, refId: approval.id };
    if (approval.toolName === REQUEST_SECRET_TOOL) {
      const input = (approval.toolInput ?? {}) as { target?: string; name?: string; reason?: string };
      const link = this.secretLinks.create(approval.id);
      const text =
        `🔐 The assistant needs ${secretLabel(input)}.${input.reason ? `\n${input.reason}` : ''}\n\n` +
        (link
          ? `Open this one-time link (valid 10 minutes) and enter it there — never type a key into this chat:\n${link}`
          : 'Open the dashboard: a card with a secure field is waiting there. (Set PUBLIC_URL to get a one-time link here instead.)');
      await this.gateway.send(channelId, chatId, text, undefined, approval.taskId, ref);
      return;
    }
    try {
      const sent = await this.gateway.sendApproval(channelId, chatId, approval);
      if (sent) await this.channels.linkMessage(channelId, chatId, sent.messageId, approval.taskId, ref);
    } catch (err) {
      this.logger.warn(`sendApproval failed: ${(err as Error).message}`);
    }
  }

  /** A voice message: transcribe it, show what was heard, then handle it exactly like typed text. */
  private async handleVoice(row: ChannelRow, e: Extract<IncomingEvent, { type: 'voice' }>): Promise<void> {
    const reply = (text: string) => this.gateway.send(row.id, e.chatId, text);
    if (!this.voice.sttReady()) {
      await reply('🎤 Voice messages are not set up yet — an operator can enable them in Settings → Voice.');
      return;
    }
    if (e.durationSec && e.durationSec > MAX_AUDIO_SECONDS) {
      await reply(`🎤 That message is too long (${Math.round(e.durationSec)} s) — please keep it under ${MAX_AUDIO_SECONDS / 60} minutes.`);
      return;
    }
    let text: string;
    try {
      text = await this.gateway.withActivity(row.id, e.chatId, 'typing', () => this.voice.transcribe(Buffer.from(e.data, 'base64'), e.mime));
    } catch (err) {
      await reply(`🎤 ⚠️ ${(err as Error).message}`);
      return;
    }
    if (!text) {
      await reply('🤔 I could not make out any words — could you say it again?');
      return;
    }
    // The echo lets the person catch a mishearing before the agent acts on it.
    await reply(`🎤 «${text}»`);
    await this.handleIncoming(row, { type: 'message', chatId: e.chatId, userId: e.userId, userName: e.userName, text, isReply: e.isReply, replyToMessageId: e.replyToMessageId, replyToText: e.replyToText, messageId: e.messageId });
  }

  /** Also speak a final answer, when the chat has voice replies on. Never blocks or fails the text reply. */
  private async speakReply(channelId: string, chatId: string, text: string): Promise<void> {
    if (!this.voice.ttsReady()) return;
    const adapter = this.gateway.adapterFor(channelId);
    if (!adapter?.sendVoice) return;
    try {
      const { audio, mime, truncated } = await this.gateway.withActivity(channelId, chatId, 'record_voice', () => this.voice.speak(text, 'opus'));
      await adapter.sendVoice(chatId, { data: audio, mime }, truncated ? '🔊 (shortened — the full answer is in the text above)' : undefined);
    } catch (err) {
      this.logger.warn(`voice reply failed: ${(err as Error).message}`);
      await this.gateway.send(channelId, chatId, `🔊 Could not make the voice version: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  /** The bot token was just saved: switch the channel on if it was waiting for it, (re)start polling, and report connectivity. */
  async onSecretSaved(channelId: string): Promise<{ ok: boolean; info?: string; error?: string }> {
    const row = await this.channels.getRow(channelId);
    if (!row.enabled && this.channels.isConfigured(row)) await this.channels.update(channelId, { enabled: true });
    await this.reload();
    return this.channels.test(channelId);
  }

  /** A chat was just put on the allow-list: apply it and say hello there. */
  async onChatAllowed(channelId: string, chatId: string): Promise<void> {
    await this.reload();
    await this.gateway.send(channelId, chatId, '✅ This chat is connected. Send a message to talk to the assistant, or /help for commands.');
  }

  /**
   * A notice for the operators that belongs to no task (disk space, …): to the default notification chat (Settings → Escalations), or — when none
   * is set — to every allowed chat of every enabled channel.
   */
  async notifyOperators(text: string): Promise<void> {
    const settings = await this.prisma.appSettings.findUnique({ where: { id: 'singleton' }, select: { notifyChannelId: true, notifyChatId: true } });
    if (settings?.notifyChannelId && settings.notifyChatId) {
      await this.gateway.send(settings.notifyChannelId, settings.notifyChatId, text);
      return;
    }
    for (const row of (await this.channels.list()).filter((r) => r.enabled && this.channels.isConfigured(r))) {
      for (const chatId of this.channels.allowedChatIds(row)) await this.gateway.send(row.id, chatId, text);
    }
  }

  /** Post plain text to a chat of a channel (scheduled reminders, pairing replies). False when it could not be delivered (channel off, transport error). */
  async sendText(channelId: string, chatId: string, text: string): Promise<boolean> {
    return this.gateway.sendText(channelId, chatId, text);
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
      // The person says the task is finished ("done", "готово"): close it, don't start a run.
      if (isDoneMessage(text) && !attachments?.length) {
        const cur = await this.prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
        if (cur && ['review', 'blocked', 'stalled', 'failed'].includes(cur.status)) {
          await this.tasks.markDone(taskId);
          if (incomingMessageId) void this.gateway.react(channelId, chatId, incomingMessageId, '✅');
          await this.gateway.send(channelId, chatId, '✅ Marked as done.', undefined, taskId);
          return;
        }
      }
      const result = await this.tasks.followUp(taskId, text, attachments);
      if (incomingMessageId) {
        await this.setAck(taskId, channelId, chatId, incomingMessageId);
        void this.gateway.react(channelId, chatId, incomingMessageId, result.queued ? '📥' : '👀');
      }
      // "Queued" / "Continuing…" are system notes: only for chats that asked for them (/progress on). The reaction on the message (👀 / 📥)
      // already says it was received.
      if (!(await this.dest.prefs(channelId, chatId)).progress) return;
      const prefix = attachedLabel ? `📎 Attached ${attachedLabel} — ` : '';
      const sent = await this.gateway.send(
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
      if (incomingMessageId) void this.gateway.react(channelId, chatId, incomingMessageId, '⚠️');
      await this.gateway.send(channelId, chatId, `⚠️ ${(err as Error).message}`);
    }
  }

  /** A tap on a "⏹ Cancel" button — same logic as the /cancel command, just
   *  reachable without knowing the taskId is implicitly "the active one". */
  private async cancelViaButton(channelId: string, chatId: string, taskId: string): Promise<void> {
    const task = await this.tasks.get(taskId).catch(() => null);
    if (!task) {
      await this.gateway.send(channelId, chatId, 'Task not found (it may have been deleted).');
      return;
    }
    if (isTerminalStatus(task.status)) {
      await this.gateway.send(channelId, chatId, `Task is already ${task.status}.`);
      return;
    }
    await this.tasks.cancel(taskId);
    await this.gateway.send(channelId, chatId, '🛑 Cancelled.');
  }

  /**
   * A reaction on a message we sent. Currently only meaningful on an approval
   * message: 👍 approves, 👎 denies — the same effect as tapping the
   * Approve/Deny buttons or typing /approve, just via an emoji. Any other
   * reaction (or one on a message that stands for nothing) is silently ignored.
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
    const link = await this.channels.linkedMessage(channelId, chatId, messageId);
    if (link?.kind !== 'approval' || !link.refId) return; // not a message we track reactions for
    const decision = emoji === '👍' ? 'approve' : 'deny';
    await this.approvals
      .decide(link.refId, decision, { displayName: `${channelKind}:${who}` })
      .catch((err) => this.logger.warn(`reaction-decide failed: ${(err as Error).message}`));
  }

  // ---- Incoming (chat → orchestrator) --------------------------------------

  private async handleIncoming(row: ChannelRow, e: IncomingEvent): Promise<void> {
    const channelId = row.id;
    // Authorize: only allowlisted chats may drive the channel (deny by default).
    if (!this.channels.allowedChatIds(row).includes(e.chatId)) {
      this.logger.warn(`Ignoring ${e.type} from unauthorized chat ${e.chatId}`);
      // A stranger who wrote to the bot: remember it so the owner can allow it (Settings → Channels, or via the admin),
      // and tell the person their chat id. They still cannot do anything until allowed.
      if (e.type === 'message') {
        const { reply } = this.pairing.record(channelId, { chatId: e.chatId, userId: e.userId, userName: e.userName, text: e.text });
        if (reply) {
          await this.gateway.send(
            channelId,
            e.chatId,
            `👋 This chat is not connected yet.\nIts id: ${e.chatId}\nThe owner can allow it in the dashboard (Settings → Channels) or by telling the admin assistant "allow chat ${e.chatId}".`,
          );
        }
      }
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

    if (e.type === 'question-answer') {
      const q = await this.questions.get(e.questionId).catch(() => null);
      if (!q || !(await this.chatMayAnswer(channelId, e.chatId, q))) {
        this.logger.warn(`Chat ${e.chatId} not allowed to answer question ${e.questionId}`);
        return;
      }
      await this.questions
        .answer(e.questionId, { index: e.index }, { displayName: `${row.kind}:${e.userName ?? e.userId}` })
        .catch((err) => this.logger.warn(`answer failed: ${(err as Error).message}`));
      return;
    }

    if (e.type === 'mark-done') {
      // only a chat that belongs to the task may close it
      const mine = await this.prisma.channelThread.findFirst({ where: { channelId, externalThreadId: e.chatId, taskId: e.taskId }, select: { id: true } });
      if (!mine) return void this.logger.warn(`Chat ${e.chatId} may not close task ${e.taskId}`);
      await this.tasks
        .markDone(e.taskId)
        .then(() => this.gateway.send(channelId, e.chatId, '✅ Marked as done.', undefined, e.taskId))
        .catch((err) => this.gateway.send(channelId, e.chatId, `⚠️ ${(err as Error).message}`));
      return;
    }

    if (e.type === 'question-toggle' || e.type === 'question-done') {
      const q = await this.questions.get(e.questionId).catch(() => null);
      if (!q || q.status !== 'pending' || !q.multiple || !(await this.chatMayAnswer(channelId, e.chatId, q))) return;
      const picked = this.questionPicks.get(q.id) ?? new Set<number>();
      this.questionPicks.set(q.id, picked);
      if (e.type === 'question-done') {
        if (!picked.size) return void (await this.gateway.send(channelId, e.chatId, '☑️ Tick at least one option first.'));
        await this.questions
          .answer(q.id, { indexes: [...picked] }, { displayName: `${row.kind}:${e.userName ?? e.userId}` })
          .catch((err) => this.logger.warn(`answer failed: ${(err as Error).message}`));
        return;
      }
      if (picked.has(e.index)) picked.delete(e.index);
      else if (q.options[e.index] !== undefined) picked.add(e.index);
      const ref = (await this.channels.messagesFor('question', q.id)).find((r) => r.channelId === channelId && r.chatId === e.chatId);
      if (ref) await this.gateway.setButtons(ref, questionButtons(q, picked));
      return;
    }

    if (e.type === 'voice') {
      await this.handleVoice(row, e);
      return;
    }

    if (e.type === 'attachment') {
      await this.handleAttachment(row, e).catch((err) =>
        this.gateway.send(channelId, e.chatId, `⚠️ ${(err as Error).message}`),
      );
      return;
    }

    if (e.type === 'task-switch') {
      const ctx = { channelId, chatId: e.chatId, userId: e.userId, kind: row.kind };
      const reply = await this.commands
        .switchToTaskById(ctx, e.taskId)
        .catch((err) => `⚠️ ${(err as Error).message}`);
      await this.gateway.send(channelId, e.chatId, reply);
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

    await this.handleText(row, e);
  }

  /** A text message: where it goes is decided by resolveTarget (inbound-routing.ts); this gathers the facts and acts. */
  private async handleText(row: ChannelRow, e: Extract<IncomingEvent, { type: 'message' }>): Promise<void> {
    const channelId = row.id;
    const ctx = { channelId, chatId: e.chatId, userId: e.userId, kind: row.kind };
    const by = { displayName: `${row.kind}:${e.userName ?? e.userId}` };

    // `/pm text` or `@pm text` — straight to that agent (small typos in the name are forgiven).
    const addr = await this.commands.resolveAddress(e.text);
    if (addr && 'reply' in addr) {
      await this.gateway.send(channelId, e.chatId, addr.reply);
      return;
    }
    // Slash commands manage the conversation (new-task, tasks, task, clear, …). They come before everything but an
    // address (see the precedence table) — decided here without the lookups below.
    if (!addr && this.commands.isCommand(e.text)) {
      const reply = await this.commands
        .handle(ctx, e.text)
        .catch((err) => `⚠️ ${(err as Error).message}`);
      if (typeof reply === 'string') await this.gateway.send(channelId, e.chatId, reply);
      else await this.gateway.send(channelId, e.chatId, reply.text, reply.buttons);
      return;
    }

    const state = await this.channels.chatState(channelId, e.chatId);
    const activeTask = state.activeTaskId ? await this.liveTask(state.activeTaskId) : null;
    const facts: RoutingFacts = { address: addr, activeTask };
    let openQuestion: AgentQuestion | null = null;
    if (!addr) {
      // Replying to (quoting) a message a task sent addresses THAT task — whichever agent wrote it, whatever the chat's active task is.
      facts.quotedTaskId = await this.quotedTask(channelId, e.chatId, e.replyToMessageId);
      // An agent is waiting for an answer in this conversation: a plain message IS the answer (a number picks that option).
      const waiting = spokenToTask(facts);
      const q = waiting ? await this.questions.pendingForTask(waiting).catch(() => null) : null;
      if (q && (await this.chatMayAnswer(channelId, e.chatId, q))) facts.openQuestion = openQuestion = q;
    }
    // a forgiven typo is echoed once so a wrong guess does not go unnoticed
    if (addr?.fuzzy) await this.gateway.send(channelId, e.chatId, `↪ «${addr.agent}» (you typed ${addr.typed})`);

    const target = resolveTarget(facts);
    const text = withQuote(addr ? addr.rest : e.text, e.replyToText);
    switch (target.kind) {
      case 'select-agent': {
        // just the name: talk to this agent from now on (its own task stays active, another agent's does not)
        await this.channels.setChatState(channelId, e.chatId, { agent: target.agent, ...(activeTask?.agentName === target.agent ? {} : { activeTaskId: null }) });
        await this.gateway.send(channelId, e.chatId, `💬 Now talking to «${target.agent}» — send your message.`);
        return;
      }
      case 'answer': {
        const q = openQuestion!;
        const r = resolveAnswer(q.options, q.allowText, { text: e.text }, q.multiple);
        if ('error' in r) {
          await this.gateway.send(channelId, e.chatId, `❓ ${r.error}`);
          return;
        }
        await this.questions.answer(q.id, { text: e.text }, by).catch((err) => this.gateway.send(channelId, e.chatId, `⚠️ ${(err as Error).message}`));
        return;
      }
      case 'follow-up': {
        if (target.switchTo) await this.channels.setChatState(channelId, e.chatId, { activeTaskId: target.taskId }).catch(() => undefined);
        await this.deliverFollowUp(channelId, e.chatId, target.taskId, text, undefined, undefined, e.messageId);
        return;
      }
      case 'new':
        await this.startFromMessage(row, e, text, state.progress, target.agent);
        return;
      case 'command':
        return; // handled above
    }
  }

  /** Start a task from a chat message (optionally for a named agent) and acknowledge it. */
  private async startFromMessage(
    row: ChannelRow,
    e: Extract<IncomingEvent, { type: 'message' }>,
    text: string,
    progress: boolean,
    agent?: string,
  ): Promise<void> {
    const channelId = row.id;
    const ctx = { channelId, chatId: e.chatId, userId: e.userId, kind: row.kind };
    const created = await this.commands
      .newTask(ctx, text, agent)
      .catch((err) => ({ text: `⚠️ ${(err as Error).message}`, taskId: null }));
    if (e.messageId && created.taskId) {
      // A brand-new task — remember its ack message so the final outcome updates
      // this reaction too (👀 now, ✅/❌/⛔ once it settles).
      await this.setAck(created.taskId, channelId, e.chatId, e.messageId);
      void this.gateway.react(channelId, e.chatId, e.messageId, '👀');
    } else if (e.messageId && created.text.startsWith('⚠️')) {
      void this.gateway.react(channelId, e.chatId, e.messageId, '⚠️');
    }
    // "New task … Updates will appear here" is a system note (/progress on); a failure is always shown.
    if (progress || created.text.startsWith('⚠️') || !created.taskId) await this.gateway.send(channelId, e.chatId, created.text);
  }

  /** The task, when it still exists (the chat's active task may have been deleted). */
  private async liveTask(id: string): Promise<{ id: string; agentName: string | null } | null> {
    return this.prisma.task.findUnique({ where: { id }, select: { id: true, agentName: true } });
  }

  /** The task a quoted message came from (when it is still there), else null. */
  private async quotedTask(channelId: string, chatId: string, replyToMessageId?: string): Promise<string | null> {
    if (!replyToMessageId) return null;
    const taskId = await this.channels.taskForMessage(channelId, chatId, replyToMessageId);
    if (!taskId) return null;
    return (await this.liveTask(taskId)) ? taskId : null;
  }

  /** A photo/document from the chat → attach to the active task (or start one). A file is never the answer to a question. */
  private async handleAttachment(
    row: ChannelRow,
    e: Extract<IncomingEvent, { type: 'attachment' }>,
  ): Promise<void> {
    const channelId = row.id;
    const state = await this.channels.chatState(channelId, e.chatId);
    const buf = Buffer.from(e.data, 'base64');
    const caption = withQuote(e.caption?.trim() || 'Review the attached file.', e.replyToText);
    // a file sent as a reply goes to the task that wrote the quoted message
    const target = resolveTarget({
      quotedTaskId: await this.quotedTask(channelId, e.chatId, e.replyToMessageId),
      activeTask: state.activeTaskId ? await this.liveTask(state.activeTaskId) : null,
    });
    if (target.kind === 'follow-up') {
      if (target.switchTo) await this.channels.setChatState(channelId, e.chatId, { activeTaskId: target.taskId }).catch(() => undefined);
      const meta = await this.attachments.save(target.taskId, e.fileName, Readable.from(buf));
      await this.deliverFollowUp(channelId, e.chatId, target.taskId, caption, [meta.name], meta.name, e.messageId);
      return;
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
      await this.setAck(created.id, channelId, e.chatId, e.messageId);
      void this.gateway.react(channelId, e.chatId, e.messageId, '👀');
    }
    if (state.progress) await this.gateway.send(channelId, e.chatId, `📎 New task «${created.title}» with ${meta.name}. Updates will appear here.`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
