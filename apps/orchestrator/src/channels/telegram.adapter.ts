import { basename } from 'node:path';
import { Logger } from '@nestjs/common';
import type { ChannelAdapter, ChatActivity, IncomingHandler, MessageButton, OutgoingApproval } from './channel-adapter';
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
const CALLBACK_CANCEL = 'cn:';
const CALLBACK_DONE_TASK = 'md:'; // md:<taskId> — the person accepts the task as done
const CALLBACK_ANSWER = 'qa:'; // qa:<questionId>:<option index>
const CALLBACK_TOGGLE = 'qt:'; // qt:<questionId>:<option index> — tick/untick (multiple choice)
const CALLBACK_DONE = 'qd:'; // qd:<questionId> — send the ticked options

/**
 * Telegram transport over the Bot API using long-polling (getUpdates) — no
 * public URL needed, so it works on a local/self-hosted server. Sends plain
 * messages and approval prompts with inline Approve/Deny buttons.
 */
/** Cut to `max` UTF-16 units (Telegram's limit) without splitting an emoji / rare CJK character in two, adding an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1; // the cut would fall between the halves of a surrogate pair
  return `${text.slice(0, end)}…`;
}

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

  async sendMessage(chatId: string, text: string, buttons?: MessageButton[][]): Promise<{ messageId: string }> {
    // Telegram caps a message at 4096 chars — truncate defensively.
    const body = clip(text, 4096);
    const msg = await this.call<{ message_id: number }>('sendMessage', {
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
    return { messageId: String(msg.message_id) };
  }

  /** Replace a message's text in place — omitting reply_markup leaves any
   *  existing inline keyboard (e.g. the "⏹ Cancel" button) untouched. */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const body = clip(text, 4096);
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: Number(messageId),
      text: body,
    }).catch(() => undefined); // "message not modified" / message gone — best effort
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

  async sendVoice(chatId: string, audio: { data: Buffer; mime: string }, caption?: string): Promise<void> {
    // Ogg/Opus is what Telegram shows as a round-trip voice message; anything else goes out as an audio file.
    const voice = /ogg|opus/i.test(audio.mime);
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) form.append('caption', caption);
    form.append(voice ? 'voice' : 'audio', new Blob([new Uint8Array(audio.data)], { type: audio.mime }), voice ? 'reply.ogg' : 'reply.mp3');
    const res = await fetch(`${API}/bot${this.token}/${voice ? 'sendVoice' : 'sendAudio'}`, { method: 'POST', body: form });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(data.description || `Telegram ${voice ? 'sendVoice' : 'sendAudio'} failed (${res.status})`);
  }

  async sendImages(chatId: string, images: { data: Buffer; filename: string }[], caption?: string): Promise<void> {
    const list = images.slice(0, 10);
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append(
      'media',
      JSON.stringify(list.map((img, i) => ({ type: 'photo', media: `attach://p${i}`, ...(i === 0 && caption ? { caption: caption.slice(0, 1024) } : {}) }))),
    );
    list.forEach((img, i) => form.append(`p${i}`, new Blob([new Uint8Array(img.data)]), img.filename));
    const res = await fetch(`${API}/bot${this.token}/sendMediaGroup`, { method: 'POST', body: form });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(data.description || `Telegram sendMediaGroup failed (${res.status})`);
  }

  async sendDocument(
    chatId: string,
    file: { data: Buffer; filename: string; mime?: string },
    caption?: string,
  ): Promise<void> {
    // sendDocument needs multipart/form-data with the file part — same shape as
    // sendPhoto, just the generic (any-MIME, up to 50MB) Bot API method.
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) form.append('caption', caption.slice(0, 1024));
    form.append('document', new Blob([file.data], file.mime ? { type: file.mime } : undefined), file.filename);
    const res = await fetch(`${API}/bot${this.token}/sendDocument`, { method: 'POST', body: form });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(data.description || `Telegram sendDocument failed (${res.status})`);
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

  /** Swap the inline keyboard under a message (the ticks of a multiple-choice question). */
  async setButtons(chatId: string, messageId: string, buttons: MessageButton[][]): Promise<void> {
    await this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: Number(messageId),
      reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.label.slice(0, 64), callback_data: b.data.slice(0, 64) }))) },
    }).catch(() => undefined); // unchanged / gone — best effort
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

  /** React to a message with an emoji (e.g. acknowledging a follow-up was
   *  received/queued). Best-effort: the message may be too old, or the bot may
   *  lack the right permission in a group — never worth failing the caller. */
  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.call('setMessageReaction', {
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: [{ type: 'emoji', emoji }],
    }).catch(() => undefined);
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

  /** "typing…" / "recording a voice message…" etc. — Telegram shows it for ~5 s, so callers repeat it while busy. */
  async setActivity(chatId: string, activity: ChatActivity): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: activity }).catch(() => undefined);
  }

  /** Replace the command menu (built-in commands + one per agent). */
  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    // Telegram keeps a menu per scope: a narrower one (private chats / groups) overrides the default, so set all three.
    // Errors are thrown (the caller retries later) — they used to be swallowed, which left a stale menu until the list changed.
    for (const scope of [{ type: 'default' }, { type: 'all_private_chats' }, { type: 'all_group_chats' }]) {
      await this.call('setMyCommands', { commands, scope });
    }
    const shown = await this.call<{ command: string }[]>('getMyCommands', { scope: { type: 'all_private_chats' } }).catch(() => []);
    this.logger.log(`Telegram command menu set: ${commands.length} commands (${shown.length} visible in private chats)`);
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
          {
            offset: this.offset,
            timeout: 30,
            // message_reaction isn't delivered unless explicitly requested, even
            // on a bot's very first getUpdates call (unlike message/callback_query).
            allowed_updates: ['message', 'callback_query', 'message_reaction'],
          },
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
    // A photo, video, round video message (video note), GIF/animation or document → download it and emit an attachment event.
    // A video's soundtrack is transcribed later by the video_digest tool, so a video note needs no special voice path.
    if (m && (m.photo?.length || m.document || m.video || m.video_note || m.animation)) {
      const doc = m.document ?? m.video ?? m.video_note ?? m.animation;
      // Photos come in sizes; the last is the largest.
      const photo = m.photo?.[m.photo.length - 1];
      const fileId = doc?.file_id ?? photo?.file_id;
      if (!fileId) return;
      const TG_LIMIT = 20 * 1024 * 1024; // what a bot is allowed to download
      const tooBig = () => this.sendMessage(String(m.chat.id), '📎 That file is too big for Telegram bots to download (20 MB). Upload it in the dashboard instead (a photo/video button in the message box), or send a shorter clip.').catch(() => undefined);
      if ((doc?.file_size ?? 0) > TG_LIMIT) return void (await tooBig());
      try {
        const { data, fileName } = await this.downloadFile(fileId, doc?.file_name ?? (m.video_note ? 'video-message.mp4' : m.video || m.animation ? 'video.mp4' : undefined));
        await onEvent({
          type: 'attachment',
          chatId: String(m.chat.id),
          userId: String(m.from?.id ?? m.chat.id),
          userName: m.from?.username ?? m.from?.first_name,
          fileName,
          data,
          caption: m.caption,
          isReply: Boolean(m.reply_to_message),
          ...replyInfo(m),
          messageId: String(m.message_id),
        });
      } catch (e) {
        this.logger.warn(`file download failed: ${(e as Error).message}`);
        if (/too big/i.test((e as Error).message)) await tooBig();
      }
      return;
    }
    // A voice message or an audio file → download and emit a voice event (transcribed upstream).
    if (m && (m.voice || m.audio)) {
      const v = (m.voice ?? m.audio)!;
      const mime = m.voice?.mime_type ?? m.audio?.mime_type ?? 'audio/ogg';
      try {
        const { data } = await this.downloadFile(v.file_id, m.audio?.file_name);
        await onEvent({
          type: 'voice',
          chatId: String(m.chat.id),
          userId: String(m.from?.id ?? m.chat.id),
          userName: m.from?.username ?? m.from?.first_name,
          data,
          mime,
          durationSec: v.duration,
          isReply: Boolean(m.reply_to_message),
          ...replyInfo(m),
          messageId: String(m.message_id),
        });
      } catch (e) {
        this.logger.warn(`voice download failed: ${(e as Error).message}`);
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
          ...replyInfo(m),
        messageId: String(m.message_id),
      });
      return;
    }
    if (u.message_reaction) {
      const r = u.message_reaction;
      // Only the emoji type is relevant here (custom-emoji reactions need a
      // premium sticker set id, not a plain string) — take the first, since a
      // user can only have one reaction per message on a bot chat in practice.
      const emoji = r.new_reaction.find((x) => x.type === 'emoji')?.emoji ?? '';
      await onEvent({
        type: 'reaction',
        chatId: String(r.chat.id),
        userId: String(r.user?.id ?? r.chat.id),
        userName: r.user?.username ?? r.user?.first_name,
        messageId: String(r.message_id),
        emoji,
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
      if (data.startsWith(CALLBACK_TOGGLE) || data.startsWith(CALLBACK_DONE)) {
        await this.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => undefined);
        if (!cq.message) return;
        const base = { chatId: String(cq.message.chat.id), userId: String(cq.from?.id ?? ''), userName: cq.from?.username ?? cq.from?.first_name };
        if (data.startsWith(CALLBACK_DONE)) return void (await onEvent({ type: 'question-done', ...base, questionId: data.slice(CALLBACK_DONE.length) }));
        const [questionId, idx] = data.slice(CALLBACK_TOGGLE.length).split(':');
        if (!questionId || !/^\d+$/.test(idx ?? '')) return;
        await onEvent({ type: 'question-toggle', ...base, questionId, index: Number(idx) });
        return;
      }
      if (data.startsWith(CALLBACK_ANSWER)) {
        await this.call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Got it' }).catch(() => undefined);
        const [questionId, idx] = data.slice(CALLBACK_ANSWER.length).split(':');
        if (!cq.message || !questionId || !/^\d+$/.test(idx ?? '')) return;
        await onEvent({
          type: 'question-answer',
          chatId: String(cq.message.chat.id),
          userId: String(cq.from?.id ?? ''),
          userName: cq.from?.username ?? cq.from?.first_name,
          questionId,
          index: Number(idx),
        });
        return;
      }
      if (data.startsWith(CALLBACK_DONE_TASK)) {
        await this.call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Marking done…' }).catch(() => undefined);
        if (!cq.message) return;
        await onEvent({
          type: 'mark-done',
          chatId: String(cq.message.chat.id),
          userId: String(cq.from?.id ?? ''),
          userName: cq.from?.username ?? cq.from?.first_name,
          taskId: data.slice(CALLBACK_DONE_TASK.length),
        });
        return;
      }
      if (data.startsWith(CALLBACK_CANCEL)) {
        await this.call('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: 'Cancelling…',
        }).catch(() => undefined);
        if (!cq.message) return;
        await onEvent({
          type: 'cancel',
          chatId: String(cq.message.chat.id),
          userId: String(cq.from?.id ?? ''),
          userName: cq.from?.username ?? cq.from?.first_name,
          taskId: data.slice(CALLBACK_CANCEL.length),
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
    message_id: number;
    text?: string;
    caption?: string;
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    reply_to_message?: { message_id: number; text?: string; caption?: string };
    /** A partial quote (the selected text of the replied-to message). */
    quote?: { text?: string };
    photo?: { file_id: string }[];
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    voice?: { file_id: string; duration?: number; mime_type?: string };
    audio?: { file_id: string; duration?: number; mime_type?: string; file_name?: string };
    video_note?: { file_id: string; duration?: number; file_size?: number; file_name?: undefined };
    animation?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; username?: string; first_name?: string };
    message?: { chat: { id: number } };
  };
  message_reaction?: {
    chat: { id: number };
    message_id: number;
    user?: { id: number; username?: string; first_name?: string };
    new_reaction: { type: string; emoji?: string }[];
    old_reaction: { type: string; emoji?: string }[];
  };
}

/** Which message a reply points at, and the quoted text (the selected part when the user quoted just a piece). */
export function replyInfo(m: { reply_to_message?: { message_id: number; text?: string; caption?: string }; quote?: { text?: string } }): { replyToMessageId?: string; replyToText?: string } {
  const r = m.reply_to_message;
  if (!r) return {};
  const text = (m.quote?.text ?? r.text ?? r.caption ?? '').trim().slice(0, 600);
  return { replyToMessageId: String(r.message_id), ...(text ? { replyToText: text } : {}) };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
