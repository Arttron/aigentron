import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The chat a task's messages go to. `own` = false: a subtask shown in its parent's chat. */
export interface ChatDest {
  channelId: string;
  chatId: string;
  own: boolean;
}

/** A chat's switches (/mute, /progress, /voice). */
export interface ChatPrefs {
  muted: boolean;
  progress: boolean;
  voice: boolean;
}

/** How long a chat's switches may be served from memory (they change only through setChatState, which invalidates). */
const PREFS_TTL_MS = 10_000;
const NO_PREFS: ChatPrefs = { muted: false, progress: false, voice: false };

/**
 * Where a task speaks: its own chat thread, else (a subtask has no thread of its own) its parent's — one rule for
 * status, questions, approvals and the typing indicator. Chat switches are cached for a few seconds: an agent fires
 * dozens of log events a minute and each used to cost a query even with /progress off.
 */
@Injectable()
export class ChatDestinationService {
  private readonly prefsCache = new Map<string, { at: number; value: ChatPrefs }>();

  constructor(private readonly prisma: PrismaService) {}

  /** The chat of a task, falling back to its parent's chat for a subtask. Null = no chat (a dashboard task). */
  async destForTask(taskId: string): Promise<ChatDest | null> {
    const own = await this.thread(taskId);
    if (own) return { ...own, own: true };
    const t = await this.prisma.task.findUnique({ where: { id: taskId }, select: { parentId: true } });
    if (!t?.parentId) return null;
    const parent = await this.thread(t.parentId);
    return parent ? { ...parent, own: false } : null;
  }

  /** The chat's switches, served from a short cache. */
  async prefs(channelId: string, chatId: string): Promise<ChatPrefs> {
    const key = `${channelId}\u0000${chatId}`;
    const hit = this.prefsCache.get(key);
    if (hit && Date.now() - hit.at < PREFS_TTL_MS) return hit.value;
    const row = await this.prisma.channelChatState.findUnique({ where: { channelId_chatId: { channelId, chatId } }, select: { muted: true, progress: true, voice: true } });
    const value = row ? { muted: row.muted, progress: row.progress, voice: row.voice } : NO_PREFS;
    this.prefsCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** The chat's switches changed (setChatState): forget what was cached. */
  invalidate(channelId: string, chatId: string): void {
    this.prefsCache.delete(`${channelId}\u0000${chatId}`);
  }

  private async thread(taskId: string): Promise<{ channelId: string; chatId: string } | null> {
    const t = await this.prisma.channelThread.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' }, select: { channelId: true, externalThreadId: true } });
    return t ? { channelId: t.channelId, chatId: t.externalThreadId } : null;
  }
}
