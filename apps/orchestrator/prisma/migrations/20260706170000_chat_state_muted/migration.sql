-- Per-chat mute flag: suppress routine task-outcome posts (approvals still sent).
ALTER TABLE "ChannelChatState" ADD COLUMN "muted" BOOLEAN NOT NULL DEFAULT false;
