import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ChannelAdapter, ProbedSender } from './channel-adapter';
import { CHANNEL_KINDS, getKind, kindMeta, type ChannelFieldDef } from './channel-kinds';
import { ChatDestinationService } from './chat-destination.service';

type ChannelRow = NonNullable<Awaited<ReturnType<PrismaService['channel']['findUnique']>>>;

/** Raw config object (kind-specific keys). Secrets are masked on the wire. */
export type ChannelConfig = Record<string, unknown>;

/**
 * Config keys the runtime writes (not declared fields, never on the wire, kept across edits): the transport's inbound
 * cursor, so a restart / reload does not replay already-handled updates.
 */
export const RUNTIME_CONFIG_KEYS = ['lastUpdateId'] as const;

/** What a chat message we sent stands for (ChannelMessageLink.kind). */
export type MessageLinkKind = 'approval' | 'question' | 'ack' | 'attachment';

/** A message we sent (or the person's own message we acked), with what it stands for. */
export interface LinkedMessage {
  channelId: string;
  chatId: string;
  messageId: string;
  taskId: string;
  kind: MessageLinkKind | null;
  refId: string | null;
}

/** The part of a channel row that decides whether its adapter must be rebuilt (runtime keys excluded). */
export function adapterSignature(row: { kind: string; name: string; enabled: boolean; config: unknown }): string {
  const config = { ...((row.config ?? {}) as ChannelConfig) };
  for (const k of RUNTIME_CONFIG_KEYS) delete config[k];
  return JSON.stringify({ kind: row.kind, name: row.name, enabled: row.enabled, config });
}

export interface ChannelPatch {
  name?: string;
  kind?: string;
  enabled?: boolean;
  config?: ChannelConfig;
}

/**
 * Registry + CRUD for external channels. Per-kind knowledge (fields, secrets,
 * adapter) lives in the channel-kinds registry, so this stays kind-agnostic:
 * secrets are masked on the wire, blank secrets are preserved on update, and
 * adding a kind needs no change here.
 */
@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dest: ChatDestinationService,
  ) {}

  /** Browser-safe kind metadata (for the add/edit picker + dynamic form). */
  kinds() {
    return kindMeta();
  }

  /** Non-secret wire shape: declared config values + a masked marker per secret. */
  serialize(row: ChannelRow) {
    const config = (row.config ?? {}) as ChannelConfig;
    const def = getKind(row.kind);
    const publicConfig: Record<string, unknown> = {};
    const secrets: Record<string, { set: boolean; hint: string | null }> = {};
    for (const field of def?.fields ?? []) {
      const value = config[field.key];
      if (field.secret) {
        const s = typeof value === 'string' ? value : '';
        secrets[field.key] = { set: Boolean(s), hint: s ? `…${s.slice(-4)}` : null };
      } else {
        publicConfig[field.key] = value ?? (field.type === 'list' ? [] : '');
      }
    }
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      enabled: row.enabled,
      config: publicConfig,
      secrets,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(): Promise<ChannelRow[]> {
    return this.prisma.channel.findMany({ orderBy: { name: 'asc' } });
  }

  async getRow(id: string): Promise<ChannelRow> {
    const row = await this.prisma.channel.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Channel not found: ${id}`);
    return row;
  }

  /**
   * `draft` = created by the admin before its secret exists: the required secret may be missing and the channel stays
   * switched off until the token is entered (request_secret) — see ChannelManagerService.onSecretSaved.
   */
  async create(patch: ChannelPatch, opts: { draft?: boolean } = {}): Promise<ChannelRow> {
    if (!patch.name?.trim()) throw new BadRequestException('name is required');
    const def = getKind(patch.kind ?? '');
    if (!def || !def.available) {
      const available = CHANNEL_KINDS.filter((k) => k.available).map((k) => k.kind);
      throw new BadRequestException(`kind must be one of: ${available.join(', ')}`);
    }
    const config = normalizeConfig(def.fields, patch.config, {});
    for (const f of def.fields) {
      if (f.required && !config[f.key] && !(opts.draft && f.secret)) throw new BadRequestException(`${f.label} is required`);
    }
    return this.prisma.channel.create({
      data: {
        name: patch.name.trim(),
        kind: def.kind,
        enabled: opts.draft ? false : (patch.enabled ?? true),
        config: config as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * "Find my id": wait for the next message to the account described by `kind` + `config` (a new channel's form values; with `id` the stored secrets
   * fill in what the form left blank) and say who wrote what. Builds a throw-away adapter — nothing is saved.
   */
  async probeSender(input: { kind: string; config?: ChannelConfig; id?: string; waitSeconds?: number }): Promise<{ found: false } | ({ found: true } & ProbedSender)> {
    const def = getKind(input.kind);
    if (!def?.available || !def.build) throw new BadRequestException('this kind of channel cannot be probed');
    const current = input.id ? ((await this.getRow(input.id)).config as ChannelConfig) : {};
    const config = normalizeConfig(def.fields, input.config, current);
    for (const f of def.fields) if (f.required && !config[f.key]) throw new BadRequestException(`${f.label} is required`);
    // a bot that a RUNNING channel already reads: a second reader would take (and confirm) the messages that channel is waiting for
    const secretKey = def.fields.find((f) => f.secret)?.key;
    if (secretKey && config[secretKey]) {
      const used = (await this.list()).find((r) => r.id !== input.id && r.enabled && (r.config as ChannelConfig)?.[secretKey] === config[secretKey]);
      if (used) throw new BadRequestException(`This bot is already used by the running channel "${used.name}" — look at its list of waiting chats instead, or switch that channel off first.`);
    }
    const adapter = def.build('probe', config);
    if (!adapter.probeSender) throw new BadRequestException('this kind of channel cannot be probed');
    const wait = Math.min(25, Math.max(1, Math.floor(input.waitSeconds ?? 20)));
    const got = await adapter.probeSender(wait).catch((e) => {
      throw new BadRequestException((e as Error).message);
    });
    return got ? { found: true, ...got } : { found: false };
  }

  async update(id: string, patch: ChannelPatch): Promise<ChannelRow> {
    const row = await this.getRow(id);
    const def = getKind(row.kind);
    const current = (row.config ?? {}) as ChannelConfig;
    const config = def ? normalizeConfig(def.fields, patch.config, current) : current;
    return this.prisma.channel.update({
      where: { id },
      data: {
        ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        config: config as Prisma.InputJsonValue,
      },
    });
  }

  /** Write runtime keys (the inbound cursor) into the config without touching the declared fields. Not a user edit: no reload. */
  async setRuntimeConfig(id: string, patch: Partial<Record<(typeof RUNTIME_CONFIG_KEYS)[number], number>>): Promise<void> {
    const row = await this.prisma.channel.findUnique({ where: { id }, select: { config: true } });
    if (!row) return;
    const config = { ...((row.config ?? {}) as ChannelConfig), ...patch };
    await this.prisma.channel.update({ where: { id }, data: { config: config as Prisma.InputJsonValue } });
  }

  /** Add (or remove) one chat id on the allow-list, leaving the rest of the config untouched. */
  async setChatAllowed(id: string, chatId: string, allowed: boolean): Promise<ChannelRow> {
    const row = await this.getRow(id);
    const cur = this.allowedChatIds(row);
    const next = allowed ? Array.from(new Set([...cur, String(chatId).trim()])) : cur.filter((c) => c !== String(chatId).trim());
    return this.update(id, { config: { allowedChatIds: next } });
  }

  /** Store a secret field (e.g. the bot token) without it ever passing through the API body of a normal edit. */
  async setSecret(id: string, key: string, value: string): Promise<ChannelRow> {
    const row = await this.getRow(id);
    const def = getKind(row.kind);
    if (!def?.fields.some((f) => f.key === key && f.secret)) throw new BadRequestException(`"${key}" is not a secret of this channel.`);
    return this.update(id, { config: { [key]: value } });
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id);
    await this.prisma.channel.delete({ where: { id } });
  }

  /** Build a transport adapter for a channel row (via the kind registry). */
  buildAdapter(row: ChannelRow): ChannelAdapter {
    const def = getKind(row.kind);
    if (!def?.build) throw new BadRequestException(`Unsupported channel kind: ${row.kind}`);
    return def.build(row.name, (row.config ?? {}) as ChannelConfig);
  }

  /** Verify a channel's connectivity/credentials (e.g. Telegram getMe). */
  async test(id: string): Promise<{ ok: boolean; info?: string; error?: string }> {
    const row = await this.getRow(id);
    return this.buildAdapter(row).verify();
  }

  config(row: ChannelRow): ChannelConfig {
    return (row.config ?? {}) as ChannelConfig;
  }

  /** Chat ids allowed to drive this channel (generic across kinds). */
  allowedChatIds(row: ChannelRow): string[] {
    const v = (row.config as ChannelConfig)?.allowedChatIds;
    return Array.isArray(v) ? v.map(String) : [];
  }

  /** Default agent for tasks originating from this channel, if configured. */
  defaultAgent(row: ChannelRow): string | undefined {
    const v = (row.config as ChannelConfig)?.defaultAgent;
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  }

  /** Whether the channel has the secrets it needs to connect. */
  isConfigured(row: ChannelRow): boolean {
    const def = getKind(row.kind);
    const config = (row.config ?? {}) as ChannelConfig;
    return (def?.fields ?? []).every((f) => !f.required || Boolean(config[f.key]));
  }

  // ---- Task ↔ conversation threads -----------------------------------------

  async linkThread(channelId: string, taskId: string, externalThreadId: string): Promise<void> {
    await this.prisma.channelThread
      .create({ data: { channelId, taskId, externalThreadId } })
      .catch(() => undefined); // unique — ignore a duplicate binding
  }

  // (which chat a task speaks in — own thread or the parent's — is ChatDestinationService.destForTask)

  // ---- Per-conversation session state (active task + agent/model) ----------

  async chatState(channelId: string, chatId: string) {
    return this.prisma.channelChatState.upsert({
      where: { channelId_chatId: { channelId, chatId } },
      update: {},
      create: { channelId, chatId },
    });
  }

  async setChatState(
    channelId: string,
    chatId: string,
    patch: { activeTaskId?: string | null; agent?: string | null; model?: string | null; muted?: boolean; voice?: boolean; progress?: boolean },
  ) {
    this.dest.invalidate(channelId, chatId);
    return this.prisma.channelChatState.upsert({
      where: { channelId_chatId: { channelId, chatId } },
      update: patch,
      create: { channelId, chatId, ...patch },
    });
  }

  // ---- which task sent which message (for quote-replies), and what the message stands for ----

  /**
   * Remember that `taskId` sent this message into the chat; replying to it later addresses that task. `ref` says what the
   * message stands for (an approval, a question, the person's own message we acked, a delivered attachment), so button
   * taps and reactions on it still work after a restart and attachments are not delivered twice.
   */
  async linkMessage(channelId: string, chatId: string, messageId: string, taskId: string, ref?: { kind: MessageLinkKind; refId: string }): Promise<void> {
    await this.prisma.channelMessageLink
      .upsert({
        where: { channelId_chatId_messageId: { channelId, chatId, messageId } },
        update: { taskId, ...(ref ?? {}) },
        create: { channelId, chatId, messageId, taskId, ...(ref ?? {}) },
      })
      .catch(() => undefined);
  }

  /** The task that sent a message (null when it was not one of a task's messages). */
  async taskForMessage(channelId: string, chatId: string, messageId: string): Promise<string | null> {
    const row = await this.prisma.channelMessageLink.findUnique({ where: { channelId_chatId_messageId: { channelId, chatId, messageId } }, select: { taskId: true } });
    return row?.taskId ?? null;
  }

  /** What a message stands for (null when it is not one of ours). */
  async linkedMessage(channelId: string, chatId: string, messageId: string): Promise<LinkedMessage | null> {
    const row = await this.prisma.channelMessageLink.findUnique({ where: { channelId_chatId_messageId: { channelId, chatId, messageId } } });
    return row ? { channelId: row.channelId, chatId: row.chatId, messageId: row.messageId, taskId: row.taskId, kind: row.kind as MessageLinkKind | null, refId: row.refId } : null;
  }

  /** Every chat message that stands for this approval / question / ack (oldest first). */
  async messagesFor(kind: MessageLinkKind, refId: string): Promise<LinkedMessage[]> {
    const rows = await this.prisma.channelMessageLink.findMany({ where: { kind, refId }, orderBy: { createdAt: 'asc' } });
    return rows.map((row) => ({ channelId: row.channelId, chatId: row.chatId, messageId: row.messageId, taskId: row.taskId, kind: row.kind as MessageLinkKind | null, refId: row.refId }));
  }

  /** Whether this chat received the message for an approval / question (it may then decide / answer it). */
  async chatHasMessageFor(channelId: string, chatId: string, kind: MessageLinkKind, refId: string): Promise<boolean> {
    return Boolean(await this.prisma.channelMessageLink.findFirst({ where: { channelId, chatId, kind, refId }, select: { id: true } }));
  }

  /** Forget the messages that stood for something (an ack that has been reacted to). The quote-link to the task stays. */
  async unlinkRef(kind: MessageLinkKind, refId: string): Promise<void> {
    await this.prisma.channelMessageLink.updateMany({ where: { kind, refId }, data: { kind: null, refId: null } }).catch(() => undefined);
  }

  /** Attachments of a task already delivered to a chat (by filename), so a later settle does not send them again. */
  async sentAttachments(taskId: string): Promise<Set<string>> {
    const rows = await this.prisma.channelMessageLink.findMany({ where: { taskId, kind: 'attachment' }, select: { refId: true } });
    return new Set(rows.map((r) => r.refId).filter((x): x is string => Boolean(x)));
  }

  /** Remember that an attachment went out (files have no message id of their own: a synthetic one keeps the row unique per chat). */
  async markAttachmentSent(channelId: string, chatId: string, taskId: string, name: string): Promise<void> {
    await this.linkMessage(channelId, chatId, `attachment:${name}`, taskId, { kind: 'attachment', refId: name });
  }

  /** Old links are of no use (nobody quotes a message from months ago). Delivered-attachment marks stay (they prevent re-sending). */
  async pruneMessageLinks(days = 60): Promise<void> {
    await this.prisma.channelMessageLink
      .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - days * 86_400_000) }, OR: [{ kind: null }, { kind: { not: 'attachment' } }] } })
      .catch(() => undefined);
  }

  /** A readable one-liner for a task: latest reported summary, else title+status. */
  async summarize(taskId: string): Promise<string> {
    const session = await this.prisma.agentSession.findFirst({
      where: { taskId, status: 'completed', reportedSummary: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { reportedSummary: true },
    });
    if (session?.reportedSummary) return session.reportedSummary;
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { title: true, status: true },
    });
    return task ? `${task.title} — ${task.status}` : taskId;
  }
}

/**
 * Coerce an incoming config to its kind's declared fields, merged over the
 * current stored config. `list` fields become trimmed string[]; a blank secret
 * keeps the stored value (so a masked form never wipes it); unknown keys drop —
 * except the runtime keys (RUNTIME_CONFIG_KEYS), which are carried over from the stored config.
 */
export function normalizeConfig(
  fields: ChannelFieldDef[],
  incoming: ChannelConfig = {},
  current: ChannelConfig = {},
): ChannelConfig {
  const out: ChannelConfig = {};
  for (const k of RUNTIME_CONFIG_KEYS) if (current[k] !== undefined) out[k] = current[k];
  for (const f of fields) {
    const raw = incoming[f.key];
    if (f.type === 'list') {
      const list = Array.isArray(raw)
        ? raw.map((s) => String(s).trim()).filter(Boolean)
        : typeof raw === 'string'
          ? raw.split(',').map((s) => s.trim()).filter(Boolean)
          : Array.isArray(current[f.key])
            ? (current[f.key] as string[])
            : [];
      if (list.length) out[f.key] = list;
    } else if (f.secret) {
      const next = typeof raw === 'string' && raw.trim() ? raw.trim() : (current[f.key] as string | undefined);
      if (next) out[f.key] = next;
    } else {
      const next = typeof raw === 'string' ? raw.trim() : (current[f.key] as string | undefined);
      if (next) out[f.key] = next;
    }
  }
  return out;
}
