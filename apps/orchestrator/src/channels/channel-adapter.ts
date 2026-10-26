/**
 * Channel adapter abstraction — the base functions any message transport
 * (Telegram now; Slack/email later) must provide. Transport-only: it moves
 * messages in and out; authorization and task/approval routing are the
 * channel manager's job.
 */

/** An approval to render for a human, with inline Approve/Deny controls. */
export interface OutgoingApproval {
  id: string;
  taskId: string;
  summary: string;
  reason: string;
}

/** A tappable inline button. `data` is opaque — echoed back via a 'task-switch'
 *  (or future button-driven) IncomingEvent when tapped, never shown to the user. */
export interface MessageButton {
  label: string;
  data: string;
}

/** A normalized inbound event from a channel. */
export type IncomingEvent =
  | {
      type: 'message';
      /** Conversation id (Telegram chat id). */
      chatId: string;
      /** External user id (for authorization + attribution). */
      userId: string;
      userName?: string;
      text: string;
      /** True when the user replied to one of our messages (→ follow-up vs new task). */
      isReply: boolean;
      /** The message this one replies to (quotes), when the transport says — used to address the task that sent it. */
      replyToMessageId?: string;
      /** The quoted text (the selected part when the transport supports partial quotes), trimmed. */
      replyToText?: string;
      /** Id of this message in the transport, for reactToMessage (ack) — optional
       *  since not every transport can supply one. */
      messageId?: string;
    }
  | {
      type: 'approval';
      chatId: string;
      userId: string;
      userName?: string;
      approvalId: string;
      decision: 'approve' | 'deny';
    }
  | {
      /** A tap on an answer button under an agent's question (ask_user). */
      type: 'question-answer';
      chatId: string;
      userId: string;
      userName?: string;
      questionId: string;
      /** Which option (0-based). */
      index: number;
    }
  | {
      /** The person accepts a result (a "✅ Mark done" button on messages sent by older versions). */
      type: 'mark-done';
      chatId: string;
      userId: string;
      userName?: string;
      taskId: string;
    }
  | {
      /** A tap on an option of a multiple-choice question: tick / untick it. */
      type: 'question-toggle';
      chatId: string;
      userId: string;
      userName?: string;
      questionId: string;
      index: number;
    }
  | {
      /** "Done" on a multiple-choice question: send what is ticked. */
      type: 'question-done';
      chatId: string;
      userId: string;
      userName?: string;
      questionId: string;
    }
  | {
      /** A tap on a task-list/subtask-list button — switch the chat's active task. */
      type: 'task-switch';
      chatId: string;
      userId: string;
      userName?: string;
      taskId: string;
    }
  | {
      /** A tap on a "⏹ Cancel" button attached to a task-related message. */
      type: 'cancel';
      chatId: string;
      userId: string;
      userName?: string;
      taskId: string;
    }
  | {
      type: 'attachment';
      chatId: string;
      userId: string;
      userName?: string;
      /** Original file name (extension is validated when saving). */
      fileName: string;
      /** File bytes, base64-encoded. */
      data: string;
      /** Optional caption sent with the file. */
      caption?: string;
      isReply: boolean;
      replyToMessageId?: string;
      replyToText?: string;
      messageId?: string;
    }
  | {
      /** A voice message / audio file / round video note — to be transcribed and handled as text. */
      type: 'voice';
      chatId: string;
      userId: string;
      userName?: string;
      /** Audio bytes, base64-encoded. */
      data: string;
      mime: string;
      /** Length in seconds, when the transport says. */
      durationSec?: number;
      isReply: boolean;
      replyToMessageId?: string;
      replyToText?: string;
      messageId?: string;
    }
  | {
      /** The human reacted (with an emoji) to a message we sent. */
      type: 'reaction';
      chatId: string;
      userId: string;
      userName?: string;
      /** Id of the message that was reacted to. */
      messageId: string;
      /** The reaction emoji, e.g. '👍'. Empty string = the reaction was removed. */
      emoji: string;
    };

export type IncomingHandler = (event: IncomingEvent) => void | Promise<void>;

/** Hooks a transport calls while polling. */
export interface PollingHooks {
  /** The transport's cursor moved past an inbound update (Telegram `update_id`); persisted so a restart/reload does not replay it. */
  onOffset?: (lastUpdateId: number) => void;
  /** Is this chat on the allow-list? Asked BEFORE a file or a voice message is downloaded (a stranger must not make the bot fetch 20 MB at a time). */
  isAllowed?: (chatId: string) => boolean;
}

/** What the bot appears to be doing (Telegram's sendChatAction actions). */
export type ChatActivity = 'typing' | 'upload_photo' | 'upload_video' | 'upload_document' | 'record_voice' | 'upload_voice' | 'record_video_note';

/** The base functions a channel transport implements. */
/** Who wrote the message a probe was waiting for (see ChannelAdapter.probeSender). */
export interface ProbedSender {
  /** the chat to put on the allow-list (a person's private chat has the same number as their user id) */
  chatId: string;
  userId: string;
  userName?: string;
  /** a group's title, when it was written from a group */
  chatTitle?: string;
  /** what they wrote */
  text: string;
}

export interface ChannelAdapter {
  readonly kind: string;
  /** Longest text one message may carry (UTF-16 units); longer texts are split by the gateway. Unset = unlimited. */
  readonly maxTextLength?: number;
  /** Connectivity/credentials check (e.g. Telegram getMe). */
  verify(): Promise<{ ok: boolean; info?: string; error?: string }>;
  /** Post a plain text message to a conversation. `buttons` is a grid of rows
   *  (each an array of buttons) rendered as tappable inline controls when the
   *  transport supports them; ignored by transports that don't. Returns the
   *  posted message's id so a caller can later edit it (e.g. a live status
   *  line) or react to it. */
  sendMessage(chatId: string, text: string, buttons?: MessageButton[][]): Promise<{ messageId: string }>;
  /**
   * Wait for the next message anybody writes to this channel's account and say who wrote what (the "find my id" helper of the add-channel form). Reads and
   * confirms that message so the running channel never sees it, and forgets what was written before the call. Only for a channel that is NOT running
   * (two readers of one Telegram bot cancel each other). Resolves null when nothing arrived within `waitSeconds`. Optional.
   */
  probeSender?(waitSeconds: number): Promise<ProbedSender | null>;
  /** Replace the buttons under a message (tick marks on a multiple-choice question). Optional. */
  setButtons?(chatId: string, messageId: string, buttons: MessageButton[][]): Promise<void>;
  /** Replace a previously-sent message's text in place (e.g. a live-updating
   *  "processing…" status line) — existing buttons/keyboard are preserved.
   *  Best-effort, optional — not every transport supports editing. */
  editMessage?(chatId: string, messageId: string, text: string): Promise<void>;
  /**
   * Show a short-lived "the bot is doing something" status in the chat ("typing…", "recording a voice message…", "sending a photo…").
   * Transports expire it after a few seconds, so callers repeat it while the work goes on. Optional.
   */
  setActivity?(chatId: string, activity: ChatActivity): Promise<void>;
  /** Replace the transport's command menu (the `/` list). Optional. */
  setCommands?(commands: { command: string; description: string }[]): Promise<void>;
  /** Post spoken audio. Ogg/Opus shows as a voice message; other formats are sent as an audio file. Optional. */
  sendVoice?(chatId: string, audio: { data: Buffer; mime: string }, caption?: string): Promise<void>;
  /** Post an image (e.g. an agent screenshot). Optional — not every transport supports it. */
  sendImage?(chatId: string, image: { data: Buffer; filename: string }, caption?: string): Promise<void>;
  /** Post 2–10 pictures as ONE album (Telegram: a media group). Optional — callers fall back to sendImage one by one. */
  sendImages?(chatId: string, images: { data: Buffer; filename: string }[], caption?: string): Promise<void>;
  /** Post an arbitrary file as a downloadable document (anything the image path
   *  doesn't cover — pdf/zip/docx/log/etc). Optional — not every transport
   *  supports it. */
  sendDocument?(
    chatId: string,
    file: { data: Buffer; filename: string; mime?: string },
    caption?: string,
  ): Promise<void>;
  /** Post an approval request with Approve/Deny controls; returns its message id. */
  sendApproval(chatId: string, approval: OutgoingApproval): Promise<{ messageId: string }>;
  /** Mark a previously-sent approval message as resolved: remove its buttons and
   *  show the outcome. No-op if the transport can't edit messages. */
  resolveApprovalMessage?(chatId: string, messageId: string, outcome: string): Promise<void>;
  /** React to a message with an emoji (e.g. acknowledging receipt). Best-effort,
   *  optional — not every transport supports message reactions. */
  reactToMessage?(chatId: string, messageId: string, emoji: string): Promise<void>;
  /** Begin receiving inbound events (long-polling). Idempotent. */
  startPolling(onEvent: IncomingHandler, hooks?: PollingHooks): void;
  /** Stop receiving and release resources. Idempotent; resolves once the polling loop has really ended. */
  stop(): Promise<void>;
}
