-- Per-chat switch: also send final answers as a voice message.
ALTER TABLE "ChannelChatState" ADD COLUMN "voice" BOOLEAN NOT NULL DEFAULT false;
