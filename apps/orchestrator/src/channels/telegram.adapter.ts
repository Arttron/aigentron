import { toTelegramHtml } from './telegram-html';
import { basename } from 'node:path';
import { Logger } from '@nestjs/common';
import type { ChannelAdapter, ChatActivity, IncomingHandler, MessageButton, OutgoingApproval, PollingHooks } from './channel-adapter';
import { COMMAND_MENU } from './command-menu';

/** Telegram bot config stored in Channel.config. */
export interface TelegramConfig {
  botToken: string;
  /** Chat ids allowed to drive the bot (empty = none — deny by default). */
  allowedChatIds?: string[];
  /** Agent used for tasks created from this channel (else the default lead). */
  defaultAgent?: string;
  /** Runtime, written by the manager: the last `update_id` handled, so a restart/reload does not replay the batch. */
  lastUpdateId?: number;
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

/** Telegram's limit for one text message (UTF-16 units). */
export const TELEGRAM_MAX_TEXT = 4096;
/** A plain API call (sendMessage, answerCallbackQuery…) must answer within this. */
const CALL_TIMEOUT_MS = 20_000;
/** Uploads and downloads (up to 20–50 MB) get longer. */
const TRANSFER_TIMEOUT_MS = 120_000;
/** The long poll asks Telegram to hold for this many seconds… */
const POLL_HOLD_S = 30;
/** …and is abandoned a little later if the socket hangs. */
const POLL_TIMEOUT_MS = (POLL_HOLD_S + 15) * 1000;
/** Retries after HTTP 429 (Telegram says how long to wait in `parameters.retry_after`). */
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_S = 30;

/** Cut to `max` UTF-16 units (Telegram's limit) without splitting an emoji / rare CJK character in two, adding an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1; // the cut would fall between the halves of a surrogate pair
  return `${text.slice(0, end)}…`;
}

/** A Bot API error with what Telegram said; `retryAfter` (seconds) when it was a rate limit. */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** How long to wait before retrying this attempt, or null when the error is not a rate limit / retries are spent. */
export function retryDelayMs(err: unknown, attempt: number, maxRetries = MAX_RETRIES): number | null {
  if (attempt >= maxRetries) return null;
  if (!(err instanceof TelegramApiError) || err.status !== 429) return null;
  const s = Math.min(Math.max(err.retryAfter ?? 1, 1), MAX_RETRY_AFTER_S);
  return s * 1000;
}

/**
 * Telegram transport over the Bot API using long-polling (getUpdates) — no
 * public URL needed, so it works on a local/self-hosted server. Sends plain
 * messages and approval prompts with inline Approve/Deny buttons.
 * Every outgoing request has a timeout; HTTP 429 is retried after `retry_after`.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly kind = 'telegram';
  readonly maxTextLength = TELEGRAM_MAX_TEXT;
  private readonly logger: Logger;
  private readonly token: string;
  private polling = false;
  /** The next update_id to ask for: one past the last one handled (persisted across restarts via config.lastUpdateId). */
  private offset: number;
  private abort?: AbortController;
  private loopDone?: Promise<void>;

  constructor(channelName: string, config: TelegramConfig) {
    this.logger = new Logger(`Telegram(${channelName})`);
    this.token = config.botToken;
    const last = Number(config.lastUpdateId);
    this.offset = Number.isFinite(last) && last >= 0 ? last + 1 : 0;
  }

  /** Parse a Bot API response; throw a TelegramApiError (with retry_after) when it is not ok. */
  private async parse<T>(res: Response, method: string): Promise<T> {
    const data = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } | null;
    if (!data?.ok) throw new TelegramApiError(data?.description || `Telegram ${method} failed (${res.status})`, res.status, data?.parameters?.retry_after);
    return data.result as T;
  }

  /** A JSON call with a timeout and 429 retries. `signal` (polling) aborts it early. */
  private async call<T = unknown>(method: string, body?: unknown, opts: { signal?: AbortSignal; timeoutMs?: number; retries?: number } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${API}/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: withTimeout(opts.signal, timeoutMs),
        });
        return await this.parse<T>(res, method);
      } catch (e) {
        const wait = retryDelayMs(e, attempt, opts.retries);
        if (wait === null || opts.signal?.aborted) throw e;
        this.logger.warn(`${method}: rate limited, retrying in ${wait / 1000}s`);
        await delay(wait);
      }
    }
  }

  /** A multipart upload (photo, document, voice) with a longer timeout and 429 retries. */
  private async postForm<T = unknown>(method: string, form: FormData): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${API}/bot${this.token}/${method}`, { method: 'POST', body: form, signal: withTimeout(undefined, TRANSFER_TIMEOUT_MS) });
        return await this.parse<T>(res, method);
      } catch (e) {
        const wait = retryDelayMs(e, attempt);
        if (wait === null) throw e;
        this.logger.warn(`${method}: rate limited, retrying in ${wait / 1000}s`);
        await delay(wait);
      }
    }
  }

  async verify(): Promise<{ ok: boolean; info?: string; error?: string }> {
    try {
      const me = await this.call<{ username?: string; first_name?: string }>('getMe');
      return { ok: true, info: `@${me.username ?? me.first_name ?? 'bot'}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private inlineKeyboard(buttons: MessageButton[][]) {
    // Telegram caps callback_data at 64 bytes and button label length isn't formally bounded but long labels get truncated by clients.
    return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.label.slice(0, 64), callback_data: b.data.slice(0, 64) }))) };
  }

  async sendMessage(chatId: string, text: string, buttons?: MessageButton[][]): Promise<{ messageId: string }> {
    // Telegram caps a message at 4096 chars — the gateway splits long texts; this is the last line of defence.
    const body = clip(text, TELEGRAM_MAX_TEXT);
    const msg = await this.callFormatted<{ message_id: number }>(
      'sendMessage',
      { chat_id: chatId, disable_web_page_preview: true, ...(buttons?.length ? { reply_markup: this.inlineKeyboard(buttons) } : {}) },
      body,
    );
    return { messageId: String(msg.message_id) };
  }

  /**
   * A text call with the text shown formatted (Markdown subset, file names in code — see telegram-html.ts). If Telegram refuses the markup the same text goes out
   * plain: a message is never lost to formatting.
   */
  private async callFormatted<T>(method: string, base: Record<string, unknown>, plain: string): Promise<T> {
    try {
      return await this.call<T>(method, { ...base, text: toTelegramHtml(plain), parse_mode: 'HTML' });
    } catch (e) {
      if (!/can't parse entities|can't find end|unsupported start tag/i.test((e as Error).message)) throw e;
      this.logger.warn(`${method}: Telegram refused the formatting, sending plain text`);
      return this.call<T>(method, { ...base, text: plain });
    }
  }

  /** Replace a message's text in place — omitting reply_markup leaves any
   *  existing inline keyboard (e.g. the "⏹ Cancel" button) untouched. */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const body = clip(text, TELEGRAM_MAX_TEXT);
    await this.callFormatted('editMessageText', { chat_id: chatId, message_id: Number(messageId) }, body).catch(() => undefined); // "message not modified" / message gone — best effort
  }

  async sendImage(chatId: string, image: { data: Buffer; filename: string }, caption?: string): Promise<void> {
    // sendPhoto needs multipart/form-data with the file part.
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) form.append('caption', caption.slice(0, 1024));
    form.append('photo', new Blob([new Uint8Array(image.data)]), image.filename);
    await this.postForm('sendPhoto', form);
  }

  async sendVoice(chatId: string, audio: { data: Buffer; mime: string }, caption?: string): Promise<void> {
    // Ogg/Opus is what Telegram shows as a round-trip voice message; anything else goes out as an audio file.
    const voice = /ogg|opus/i.test(audio.mime);
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) form.append('caption', caption);
    form.append(voice ? 'voice' : 'audio', new Blob([new Uint8Array(audio.data)], { type: audio.mime }), voice ? 'reply.ogg' : 'reply.mp3');
    await this.postForm(voice ? 'sendVoice' : 'sendAudio', form);
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
    await this.postForm('sendMediaGroup', form);
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
    form.append('document', new Blob([new Uint8Array(file.data)], file.mime ? { type: file.mime } : undefined), file.filename);
    await this.postForm('sendDocument', form);
  }

  async sendApproval(chatId: string, approval: OutgoingApproval): Promise<{ messageId: string }> {
    const text = clip(`⚠️ Approval needed for task ${approval.taskId}\n\n${approval.summary}\n${approval.reason}`, TELEGRAM_MAX_TEXT); // the full text is in the dashboard
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
      reply_markup: this.inlineKeyboard(buttons),
    }).catch(() => undefined); // unchanged / gone — best effort
  }

  /** Edit a resolved approval message: drop the buttons and show the outcome. */
  async resolveApprovalMessage(chatId: string, messageId: string, outcome: string): Promise<void> {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: Number(messageId),
      text: clip(outcome, TELEGRAM_MAX_TEXT),
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

  startPolling(onEvent: IncomingHandler, hooks: PollingHooks = {}): void {
    if (this.polling) return;
    this.polling = true;
    void this.registerCommands();
    this.loopDone = this.loop(onEvent, hooks);
  }

  /** Publish the command menu to Telegram (the `/` button next to the input). */
  private async registerCommands(): Promise<void> {
    await this.call('setMyCommands', {
      commands: COMMAND_MENU.map((c) => ({ command: c.command, description: c.description })),
    }).catch((e) => this.logger.warn(`setMyCommands failed: ${(e as Error).message}`));
  }

  /** "typing…" / "recording a voice message…" etc. — Telegram shows it for ~5 s, so callers repeat it while busy. */
  async setActivity(chatId: string, activity: ChatActivity): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: activity }, { retries: 0 }).catch(() => undefined);
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

  /** Stop polling; resolves once the loop has handed over its last update (so a replacement can start without overlap). */
  async stop(): Promise<void> {
    this.polling = false;
    this.abort?.abort();
    await this.loopDone?.catch(() => undefined);
    this.loopDone = undefined;
  }

  /** Resolve a Telegram file_id to its bytes (base64) + a filename. */
  private async downloadFile(fileId: string, name?: string): Promise<{ data: string; fileName: string }> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new Error('no file_path from getFile');
    const res = await fetch(`${API}/file/bot${this.token}/${file.file_path}`, { signal: withTimeout(undefined, TRANSFER_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`file download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString('base64'), fileName: name || basename(file.file_path) };
  }

  private async loop(onEvent: IncomingHandler, hooks: PollingHooks): Promise<void> {
    this.logger.log(`Telegram polling started (from update ${this.offset})`);
    while (this.polling) {
      this.abort = new AbortController();
      try {
        const updates = await this.call<TelegramUpdate[]>(
          'getUpdates',
          {
            offset: this.offset,
            timeout: POLL_HOLD_S,
            // message_reaction isn't delivered unless explicitly requested, even
            // on a bot's very first getUpdates call (unlike message/callback_query).
            allowed_updates: ['message', 'callback_query', 'message_reaction'],
          },
          { signal: this.abort.signal, timeoutMs: POLL_TIMEOUT_MS, retries: 0 },
        );
        for (const u of updates) {
          if (!this.polling) break; // stopped mid-batch: the rest is re-fetched by whoever polls next (the offset was not moved past it)
          if (u.update_id < this.offset) continue; // already handled (a replayed batch after a reload)
          this.offset = u.update_id + 1;
          await this.dispatch(u, onEvent).catch((e) =>
            this.logger.warn(`handler error: ${(e as Error).message}`),
          );
          hooks.onOffset?.(u.update_id);
        }
      } catch (e) {
        if (!this.polling) break; // aborted by stop()
        this.logger.warn(`getUpdates failed: ${(e as Error).message}`);
        await delay(retryDelayMs(e, 0) ?? 3000); // back off transient errors / rate limits
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

/** A signal that fires on `outer` or after `ms`, whichever comes first. */
function withTimeout(outer: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}
