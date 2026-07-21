import type { ChannelAdapter } from './channel-adapter';
import { TelegramAdapter, type TelegramConfig } from './telegram.adapter';

/**
 * A single config input for a channel kind. Drives both server-side masking/
 * normalization and the dashboard's dynamic form, so adding a channel kind is
 * one entry here + an adapter — no scattered per-kind branches.
 */
export interface ChannelFieldDef {
  /** Key inside Channel.config. */
  key: string;
  label: string;
  /** text = string · password = masked secret · list = comma-separated → string[] · agent = pick a registered agent. */
  type: 'text' | 'password' | 'list' | 'agent';
  /** Masked on the wire and preserved on update when left blank. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

/** Metadata portion of a kind (safe to expose to the browser). */
export interface ChannelKindMeta {
  kind: string;
  label: string;
  /** Implemented now? Planned kinds are listed (for the picker) but not selectable. */
  available: boolean;
  fields: ChannelFieldDef[];
  /** One-line setup hint shown in the form. */
  hint?: string;
}

interface ChannelKindDef extends ChannelKindMeta {
  build?: (name: string, config: Record<string, unknown>) => ChannelAdapter;
}

/**
 * Registry of channel kinds. Telegram is implemented; the rest are declared as
 * planned so they show in the picker (disabled) — implement one by adding its
 * fields + a `build`.
 */
export const CHANNEL_KINDS: ChannelKindDef[] = [
  {
    kind: 'telegram',
    label: 'Telegram',
    available: true,
    hint: 'Create a bot with @BotFather, paste its token, and add the chat id(s) allowed to drive it (deny by default).',
    fields: [
      { key: 'botToken', label: 'Bot token (from @BotFather)', type: 'password', secret: true, required: true, placeholder: '123456:ABC-DEF…' },
      { key: 'allowedChatIds', label: 'Allowed chat ids', type: 'list', placeholder: '12345678, -100987654321', help: 'Only these chats may create tasks / approve.' },
      { key: 'defaultAgent', label: 'Default agent', type: 'agent', help: 'Agent for tasks from this channel (blank = default lead).' },
    ],
    build: (name, config) => new TelegramAdapter(name, config as unknown as TelegramConfig),
  },
  { kind: 'slack', label: 'Slack', available: false, fields: [] },
  { kind: 'whatsapp', label: 'WhatsApp', available: false, fields: [] },
  { kind: 'viber', label: 'Viber', available: false, fields: [] },
  { kind: 'email', label: 'Email', available: false, fields: [] },
];

export function getKind(kind: string): ChannelKindDef | undefined {
  return CHANNEL_KINDS.find((k) => k.kind === kind);
}

/** Browser-safe kind metadata (no adapter factories). */
export function kindMeta(): ChannelKindMeta[] {
  return CHANNEL_KINDS.map(({ kind, label, available, fields, hint }) => ({ kind, label, available, fields, hint }));
}
