import { Injectable, Logger } from '@nestjs/common';
import { ChannelsService, type MessageLinkKind } from './channels.service';
import { splitForTransport } from './split-text';
import type { ChannelAdapter, ChatActivity, MessageButton, OutgoingApproval } from './channel-adapter';

/** A message we sent, by its address in the transport. */
export interface MessageRef {
  channelId: string;
  chatId: string;
  messageId: string;
}

/**
 * Outbound transport: the registry of RUNNING adapters (filled by ChannelManagerService.reload — only enabled,
 * configured channels) and the primitives every outgoing message goes through. A channel that is switched off or not
 * configured has no adapter here, so everything addressed to it is dropped quietly (no temporary adapter is built).
 * Long texts are split into pieces the transport accepts; every piece is linked to its task (quoting any of them
 * addresses the task), the buttons go on the last one.
 */
@Injectable()
export class ChannelGateway {
  private readonly logger = new Logger(ChannelGateway.name);
  /** Running polling adapters, keyed by channel id. */
  readonly adapters = new Map<string, ChannelAdapter>();

  constructor(private readonly channels: ChannelsService) {}

  /** The running adapter of a channel; null when the channel is disabled, unconfigured or unknown (then nothing is sent). */
  adapterFor(channelId: string): ChannelAdapter | null {
    return this.adapters.get(channelId) ?? null;
  }

  /**
   * Post a text (split into transport-sized pieces) with optional buttons on the last piece. Returns the last piece's
   * message id (the one carrying the buttons; edits/reactions go there), or null when nothing could be sent.
   * `taskId`: the task this message speaks for — replying to (quoting) any piece later addresses that task.
   */
  async send(
    channelId: string,
    chatId: string,
    text: string,
    buttons?: MessageButton[][],
    taskId?: string,
    /** What the (last piece of the) message stands for — an approval / question, so taps on it work after a restart. */
    ref?: { kind: MessageLinkKind; refId: string },
  ): Promise<{ messageId: string } | null> {
    const adapter = this.adapterFor(channelId);
    if (!adapter) return null;
    const pieces = splitForTransport(text, adapter.maxTextLength ?? Infinity);
    let last: { messageId: string } | null = null;
    try {
      for (let i = 0; i < pieces.length; i++) {
        const isLast = i === pieces.length - 1;
        const sent = await adapter.sendMessage(chatId, pieces[i]!, isLast ? buttons : undefined);
        if (sent && taskId) await this.channels.linkMessage(channelId, chatId, sent.messageId, taskId, isLast ? ref : undefined);
        last = sent;
      }
      return last;
    } catch (err) {
      this.logger.warn(`sendMessage failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Plain text to a chat. False when it could not be delivered (channel off, transport error). */
  async sendText(channelId: string, chatId: string, text: string): Promise<boolean> {
    return (await this.send(channelId, chatId, text)) !== null;
  }

  /** An approval with Approve/Deny buttons. Throws on transport errors (the caller decides how to report). */
  async sendApproval(channelId: string, chatId: string, approval: OutgoingApproval): Promise<{ messageId: string } | null> {
    const adapter = this.adapterFor(channelId);
    return adapter ? adapter.sendApproval(chatId, approval) : null;
  }

  /** Replace a message's text (live status line). Best effort. */
  async edit(ref: MessageRef, text: string): Promise<void> {
    await this.adapterFor(ref.channelId)?.editMessage?.(ref.chatId, ref.messageId, text).catch(() => undefined);
  }

  /** Replace the buttons under a message. Best effort. */
  async setButtons(ref: MessageRef, buttons: MessageButton[][]): Promise<void> {
    await this.adapterFor(ref.channelId)?.setButtons?.(ref.chatId, ref.messageId, buttons).catch(() => undefined);
  }

  /** Write the outcome over an approval/question message and drop its buttons. Best effort. */
  async resolveMessage(ref: MessageRef, outcome: string): Promise<void> {
    await this.adapterFor(ref.channelId)
      ?.resolveApprovalMessage?.(ref.chatId, ref.messageId, outcome)
      .catch((err) => this.logger.warn(`resolveApprovalMessage failed: ${(err as Error).message}`));
  }

  /** Best-effort emoji reaction on a message (bot → user ack), e.g. 👀 "working on it" / 📥 "queued". */
  async react(channelId: string, chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.adapterFor(channelId)?.reactToMessage?.(chatId, messageId, emoji).catch(() => undefined);
  }

  /** Show `activity` in the chat now, and every 4 s until the timer is cleared (Telegram forgets it after ~5 s). */
  repeatActivity(channelId: string, chatId: string, activity: ChatActivity, maxMs = 20 * 60_000): { timer: NodeJS.Timeout; stopAt: number } {
    const send = () => void this.adapterFor(channelId)?.setActivity?.(chatId, activity).catch(() => undefined);
    send();
    const stopAt = Date.now() + maxMs;
    const timer = setInterval(() => {
      if (Date.now() > stopAt) return clearInterval(timer);
      send();
    }, 4000);
    timer.unref?.();
    return { timer, stopAt };
  }

  /** Run `fn` (voice synthesis, a file upload…) with `activity` showing in the chat meanwhile. */
  async withActivity<T>(channelId: string, chatId: string, activity: ChatActivity, fn: () => Promise<T>): Promise<T> {
    const a = this.repeatActivity(channelId, chatId, activity, 5 * 60_000);
    try {
      return await fn();
    } finally {
      clearInterval(a.timer);
    }
  }
}
