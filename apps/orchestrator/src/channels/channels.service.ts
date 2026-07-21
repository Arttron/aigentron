import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ChannelAdapter } from './channel-adapter';
import { CHANNEL_KINDS, getKind, kindMeta, type ChannelFieldDef } from './channel-kinds';

type ChannelRow = NonNullable<Awaited<ReturnType<PrismaService['channel']['findUnique']>>>;

/** Raw config object (kind-specific keys). Secrets are masked on the wire. */
export type ChannelConfig = Record<string, unknown>;

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

  constructor(private readonly prisma: PrismaService) {}

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

  async create(patch: ChannelPatch): Promise<ChannelRow> {
    if (!patch.name?.trim()) throw new BadRequestException('name is required');
    const def = getKind(patch.kind ?? '');
    if (!def || !def.available) {
      const available = CHANNEL_KINDS.filter((k) => k.available).map((k) => k.kind);
      throw new BadRequestException(`kind must be one of: ${available.join(', ')}`);
    }
    const config = normalizeConfig(def.fields, patch.config, {});
    for (const f of def.fields) {
      if (f.required && !config[f.key]) throw new BadRequestException(`${f.label} is required`);
    }
    return this.prisma.channel.create({
      data: {
        name: patch.name.trim(),
        kind: def.kind,
        enabled: patch.enabled ?? true,
        config: config as Prisma.InputJsonValue,
      },
    });
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

  async latestTaskForThread(channelId: string, externalThreadId: string): Promise<string | null> {
    const t = await this.prisma.channelThread.findFirst({
      where: { channelId, externalThreadId },
      orderBy: { createdAt: 'desc' },
      select: { taskId: true },
    });
    return t?.taskId ?? null;
  }

  async threadForTask(taskId: string): Promise<{ channel: ChannelRow; externalThreadId: string } | null> {
    const thread = await this.prisma.channelThread.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      include: { channel: true },
    });
    if (!thread) return null;
    return { channel: thread.channel, externalThreadId: thread.externalThreadId };
  }

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
    patch: { activeTaskId?: string | null; agent?: string | null; model?: string | null; muted?: boolean },
  ) {
    return this.prisma.channelChatState.upsert({
      where: { channelId_chatId: { channelId, chatId } },
      update: patch,
      create: { channelId, chatId, ...patch },
    });
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
 * keeps the stored value (so a masked form never wipes it); unknown keys drop.
 */
function normalizeConfig(
  fields: ChannelFieldDef[],
  incoming: ChannelConfig = {},
  current: ChannelConfig = {},
): ChannelConfig {
  const out: ChannelConfig = {};
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
