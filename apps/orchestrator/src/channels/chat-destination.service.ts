import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';

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

  /** which project owns a chat (null = none), served from memory for a few seconds */
  private readonly owners = new Map<string, { at: number; project: string | null }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects?: ProjectsService,
  ) {}

  /** The chat of a task, falling back to its parent's chat for a subtask. Null = no chat (a dashboard task). */
  async destForTask(taskId: string): Promise<ChatDest | null> {
    const own = await this.thread(taskId);
    let found: ChatDest | null = own ? { ...own, own: true } : null;
    if (!found) {
      const t = await this.prisma.task.findUnique({ where: { id: taskId }, select: { parentId: true } });
      if (!t?.parentId) return null;
      const parent = await this.thread(t.parentId);
      found = parent ? { ...parent, own: false } : null;
    }
    // A chat that belongs to ANOTHER project hears nothing about this task, whatever thread it was linked to before the chat was bound.
    if (found && (await this.belongsToOtherProject(found, taskId))) return null;
    return found;
  }

  private async belongsToOtherProject(dest: { channelId: string; chatId: string }, taskId: string): Promise<boolean> {
    if (!this.projects) return false;
    const key = `${dest.channelId}\u0000${dest.chatId}`;
    let hit = this.owners.get(key);
    if (!hit || Date.now() - hit.at > PREFS_TTL_MS) {
      hit = { at: Date.now(), project: (await this.projects.boundToChat(dest.channelId, dest.chatId).catch(() => null))?.id ?? null };
      this.owners.set(key, hit);
    }
    if (!hit.project) return false;
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } }).catch(() => null);
    return !!task?.projectId && task.projectId !== hit.project;
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
    this.owners.delete(`${channelId}\u0000${chatId}`);
  }

  private async thread(taskId: string): Promise<{ channelId: string; chatId: string } | null> {
    const t = await this.prisma.channelThread.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' }, select: { channelId: true, externalThreadId: true } });
    return t ? { channelId: t.channelId, chatId: t.externalThreadId } : null;
  }
}
