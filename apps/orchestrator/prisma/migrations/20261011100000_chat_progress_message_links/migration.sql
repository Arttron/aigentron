-- Per-chat switch: live status line + system notes (off by default).
ALTER TABLE "ChannelChatState" ADD COLUMN "progress" BOOLEAN NOT NULL DEFAULT false;

-- Which task sent a message into a chat (for quote-replies).
CREATE TABLE "ChannelMessageLink" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMessageLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelMessageLink_channelId_chatId_messageId_key" ON "ChannelMessageLink"("channelId", "chatId", "messageId");
CREATE INDEX "ChannelMessageLink_createdAt_idx" ON "ChannelMessageLink"("createdAt");
