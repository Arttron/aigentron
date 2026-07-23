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
      /** A tap on a task-list/subtask-list button — switch the chat's active task. */
      type: 'task-switch';
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
    };

export type IncomingHandler = (event: IncomingEvent) => void | Promise<void>;

/** The base functions a channel transport implements. */
export interface ChannelAdapter {
  readonly kind: string;
  /** Connectivity/credentials check (e.g. Telegram getMe). */
  verify(): Promise<{ ok: boolean; info?: string; error?: string }>;
  /** Post a plain text message to a conversation. `buttons` is a grid of rows
   *  (each an array of buttons) rendered as tappable inline controls when the
   *  transport supports them; ignored by transports that don't. */
  sendMessage(chatId: string, text: string, buttons?: MessageButton[][]): Promise<void>;
  /** Post an image (e.g. an agent screenshot). Optional — not every transport supports it. */
  sendImage?(chatId: string, image: { data: Buffer; filename: string }, caption?: string): Promise<void>;
  /** Post an approval request with Approve/Deny controls; returns its message id. */
  sendApproval(chatId: string, approval: OutgoingApproval): Promise<{ messageId: string }>;
  /** Mark a previously-sent approval message as resolved: remove its buttons and
   *  show the outcome. No-op if the transport can't edit messages. */
  resolveApprovalMessage?(chatId: string, messageId: string, outcome: string): Promise<void>;
  /** Begin receiving inbound events (long-polling). Idempotent. */
  startPolling(onEvent: IncomingHandler): void;
  /** Stop receiving and release resources. Idempotent. */
  stop(): void;
}
