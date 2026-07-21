-- Per-conversation session state for a channel (active task + selected agent/model).
CREATE TABLE "ChannelChatState" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "activeTaskId" TEXT,
    "agent" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelChatState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChannelChatState_channelId_chatId_key" ON "ChannelChatState"("channelId", "chatId");
