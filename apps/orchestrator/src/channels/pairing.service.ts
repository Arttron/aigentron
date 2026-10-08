import { Injectable } from '@nestjs/common';

export interface PendingPairing {
  channelId: string;
  chatId: string;
  userId: string;
  userName?: string;
  /** What they wrote first (shortened) — helps the owner recognise who it is. */
  firstText?: string;
  firstSeen: number;
  lastSeen: number;
  attempts: number;
}

const TTL_MS = 60 * 60_000;
const MAX_PER_CHANNEL = 20;
/** The bot answers an unknown chat at most once per this long (no spam amplification). */
const REPLY_EVERY_MS = 10 * 60_000;

/**
 * Chats that wrote to a bot but are not on its allow-list yet ("pairing requests"). Kept in memory only: they expire after an
 * hour and nothing is stored about strangers beyond that. The owner approves one in Settings → Channels (or via the admin);
 * until then the chat can do nothing.
 */
@Injectable()
export class PairingService {
  private readonly pending = new Map<string, Map<string, PendingPairing>>();
  private readonly lastReply = new Map<string, number>();

  private bucket(channelId: string): Map<string, PendingPairing> {
    let b = this.pending.get(channelId);
    if (!b) this.pending.set(channelId, (b = new Map()));
    return b;
  }

  private prune(channelId: string, now: number): void {
    const b = this.bucket(channelId);
    for (const [k, v] of b) if (now - v.lastSeen > TTL_MS) b.delete(k);
  }

  /** Note an unauthorized chat. Returns whether the bot should answer it now. */
  record(channelId: string, e: { chatId: string; userId: string; userName?: string; text?: string }, now = Date.now()): { reply: boolean } {
    this.prune(channelId, now);
    const b = this.bucket(channelId);
    const cur = b.get(e.chatId);
    if (cur) {
      cur.lastSeen = now;
      cur.attempts += 1;
    } else if (b.size < MAX_PER_CHANNEL) {
      b.set(e.chatId, {
        channelId,
        chatId: e.chatId,
        userId: e.userId,
        userName: e.userName,
        firstText: e.text?.replace(/\s+/g, ' ').slice(0, 80),
        firstSeen: now,
        lastSeen: now,
        attempts: 1,
      });
    } else {
      return { reply: false }; // too many strangers at once — stay quiet
    }
    const key = `${channelId}:${e.chatId}`;
    const last = this.lastReply.get(key);
    if (last !== undefined && now - last < REPLY_EVERY_MS) return { reply: false };
    this.lastReply.set(key, now);
    if (this.lastReply.size > 500) this.lastReply.delete(this.lastReply.keys().next().value as string);
    return { reply: true };
  }

  list(channelId: string, now = Date.now()): PendingPairing[] {
    this.prune(channelId, now);
    return [...this.bucket(channelId).values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  has(channelId: string, chatId: string): boolean {
    return this.bucket(channelId).has(chatId);
  }

  dismiss(channelId: string, chatId: string): boolean {
    return this.bucket(channelId).delete(chatId);
  }
}
