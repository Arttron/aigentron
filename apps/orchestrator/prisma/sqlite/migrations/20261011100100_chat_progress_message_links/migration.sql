-- Per-chat switch: live status line + system notes (off by default).
ALTER TABLE "ChannelChatState" ADD COLUMN "progress" BOOLEAN NOT NULL DEFAULT false;

-- Which task sent a message into a chat (for quote-replies).
CREATE TABLE "ChannelMessageLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ChannelMessageLink_channelId_chatId_messageId_key" ON "ChannelMessageLink"("channelId", "chatId", "messageId");
CREATE INDEX "ChannelMessageLink_createdAt_idx" ON "ChannelMessageLink"("createdAt");
