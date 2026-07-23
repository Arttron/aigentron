import { basename } from 'node:path';
import { Logger } from '@nestjs/common';
import type { ChannelAdapter, IncomingHandler, MessageButton, OutgoingApproval } from './channel-adapter';
import { COMMAND_MENU } from './command-menu';

/** Telegram bot config stored in Channel.config. */
export interface TelegramConfig {
  botToken: string;
  /** Chat ids allowed to drive the bot (empty = none — deny by default). */
  allowedChatIds?: string[];
  /** Agent used for tasks created from this channel (else the default lead). */
  defaultAgent?: string;
}

const API = 'https://api.telegram.org';
const CALLBACK_APPROVE = 'ap:';
const CALLBACK_DENY = 'dn:';
const CALLBACK_TASK = 'tk:';

/**
 * Telegram transport over the Bot API using long-polling (getUpdates) — no
 * public URL needed, so it works on a local/self-hosted server. Sends plain
 * messages and approval prompts with inline Approve/Deny buttons.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly kind = 'telegram';
  private readonly logger: Logger;
  private readonly token: string;
  private polling = false;
  private offset = 0;
  private abort?: AbortController;

  constructor(channelName: string, config: TelegramConfig) {
    this.logger = new Logger(`Telegram(${channelName})`);
    this.token = config.botToken;
  }

  private async call<T = unknown>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(data.description || `Telegram ${method} failed (${res.status})`);
    return data.result as T;
  }

  async verify(): Promise<{ ok: boolean; info?: string; error?: string }> {
    try {
      const me = await this.call<{ username?: string; first_name?: string }>('getMe');
      return { ok: true, info: `@${me.username ?? me.first_name ?? 'bot'}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async sendMessage(chatId: string, text: string, buttons?: MessageButton[][]): Promise<void> {
    // Telegram caps a message at 4096 chars — truncate defensively.
    const body = text.length > 4096 ? `${text.slice(0, 4093)}…` : text;
    await this.call('sendMessage', {
      chat_id: chatId,
      text: body,
      disable_web_page_preview: true,
      ...(buttons?.length
        ? {
            reply_markup: {
              inline_keyboard: buttons.map((row) =>
                // Telegram caps callback_data at 64 bytes and button label length
                // isn't formally bounded but long labels get truncated by clients.
                row.map((b) => ({ text: b.label.slice(0, 64), callback_data: b.data.slice(0, 64) })),
              ),
            },
          }
        : {}),
    });
  }

  async sendImage(chatId: string, image: { data: Buffer; filename: string }, caption?: string): Promise<void> {
    // sendPhoto needs multipart/form-data with the file part.
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) form.append('caption', caption.slice(0, 1024));
    form.append('photo', new Blob([image.data]), image.filename);
    const res = await fetch(`${API}/bot${this.token}/sendPhoto`, { method: 'POST', body: form });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(data.description || `Telegram sendPhoto failed (${res.status})`);
  }

  async sendApproval(chatId: string, approval: OutgoingApproval): Promise<{ messageId: string }> {
    const text = `⚠️ Approval needed for task ${approval.taskId}\n\n${approval.summary}\n${approval.reason}`;
    const msg = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `${CALLBACK_APPROVE}${approval.id}` },
            { text: '⛔ Deny', callback_data: `${CALLBACK_DENY}${approval.id}` },
          ],
        ],
      },
    });
    return { messageId: String(msg.message_id) };
  }

  /** Edit a resolved approval message: drop the buttons and show the outcome. */
  async resolveApprovalMessage(chatId: string, messageId: string, outcome: string): Promise<void> {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: Number(messageId),
      text: outcome,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => undefined); // message may be gone/unchanged — best effort
  }

  startPolling(onEvent: IncomingHandler): void {
    if (this.polling) return;
    this.polling = true;
    void this.registerCommands();
    void this.loop(onEvent);
  }

  /** Publish the command menu to Telegram (the `/` button next to the input). */
  private async registerCommands(): Promise<void> {
    await this.call('setMyCommands', {
      commands: COMMAND_MENU.map((c) => ({ command: c.command, description: c.description })),
    }).catch((e) => this.logger.warn(`setMyCommands failed: ${(e as Error).message}`));
  }

  stop(): void {
    this.polling = false;
    this.abort?.abort();
  }

  /** Resolve a Telegram file_id to its bytes (base64) + a filename. */
  private async downloadFile(fileId: string, name?: string): Promise<{ data: string; fileName: string }> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new Error('no file_path from getFile');
    const res = await fetch(`${API}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`file download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString('base64'), fileName: name || basename(file.file_path) };
  }

  private async loop(onEvent: IncomingHandler): Promise<void> {
    this.logger.log('Telegram polling started');
    while (this.polling) {
      this.abort = new AbortController();
      try {
        const updates = await this.call<TelegramUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
          this.abort.signal,
        );
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.dispatch(u, onEvent).catch((e) =>
            this.logger.warn(`handler error: ${(e as Error).message}`),
          );
        }
      } catch (e) {
        if (!this.polling) break; // aborted by stop()
        this.logger.warn(`getUpdates failed: ${(e as Error).message}`);
        await delay(3000); // back off transient errors / rate limits
      }
    }
    this.logger.log('Telegram polling stopped');
  }

  private async dispatch(u: TelegramUpdate, onEvent: IncomingHandler): Promise<void> {
    const m = u.message;
    // A photo or document → download it and emit an attachment event.
    if (m && (m.photo?.length || m.document)) {
      const doc = m.document;
      // Photos come in sizes; the last is the largest.
      const photo = m.photo?.[m.photo.length - 1];
      const fileId = doc?.file_id ?? photo?.file_id;
      if (!fileId) return;
      try {
        const { data, fileName } = await this.downloadFile(fileId, doc?.file_name);
        await onEvent({
          type: 'attachment',
          chatId: String(m.chat.id),
          userId: String(m.from?.id ?? m.chat.id),
          userName: m.from?.username ?? m.from?.first_name,
          fileName,
          data,
          caption: m.caption,
          isReply: Boolean(m.reply_to_message),
        });
      } catch (e) {
        this.logger.warn(`file download failed: ${(e as Error).message}`);
      }
      return;
    }
    if (m?.text) {
      await onEvent({
        type: 'message',
        chatId: String(m.chat.id),
        userId: String(m.from?.id ?? m.chat.id),
        userName: m.from?.username ?? m.from?.first_name,
        text: m.text,
        isReply: Boolean(m.reply_to_message),
      });
      return;
    }
    if (u.callback_query) {
      const cq = u.callback_query;
      const data = cq.data ?? '';
      if (data.startsWith(CALLBACK_TASK)) {
        // Just acknowledge — unlike approve/deny there's no message to edit
        // here, the reply (task summary) arrives as a fresh message.
        await this.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => undefined);
        if (!cq.message) return;
        await onEvent({
          type: 'task-switch',
          chatId: String(cq.message.chat.id),
          userId: String(cq.from?.id ?? ''),
          userName: cq.from?.username ?? cq.from?.first_name,
          taskId: data.slice(CALLBACK_TASK.length),
        });
        return;
      }
      const prefix = data.startsWith(CALLBACK_APPROVE)
        ? CALLBACK_APPROVE
        : data.startsWith(CALLBACK_DENY)
          ? CALLBACK_DENY
          : null;
      const decision = prefix === CALLBACK_APPROVE ? ('approve' as const) : prefix === CALLBACK_DENY ? ('deny' as const) : null;
      // Acknowledge the tap so Telegram stops the spinner. The real outcome is
      // reflected by editing the message once the decision is processed.
      await this.call('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: decision ? 'Processing…' : undefined,
      }).catch(() => undefined);
      if (!decision || !prefix || !cq.message) return;
      await onEvent({
        type: 'approval',
        chatId: String(cq.message.chat.id),
        userId: String(cq.from?.id ?? ''),
        userName: cq.from?.username ?? cq.from?.first_name,
        approvalId: data.slice(prefix.length),
        decision,
      });
    }
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    caption?: string;
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    reply_to_message?: unknown;
    photo?: { file_id: string }[];
    document?: { file_id: string; file_name?: string; mime_type?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; username?: string; first_name?: string };
    message?: { chat: { id: number } };
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
