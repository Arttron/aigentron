-- External communication channels (Telegram first) + task↔conversation binding.
ALTER TABLE "Task" ADD COLUMN "createdByChannel" TEXT;

CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Channel_name_key" ON "Channel"("name");

CREATE TABLE "ChannelThread" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "externalThreadId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelThread_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChannelThread_channelId_externalThreadId_taskId_key" ON "ChannelThread"("channelId", "externalThreadId", "taskId");
CREATE INDEX "ChannelThread_taskId_idx" ON "ChannelThread"("taskId");
CREATE INDEX "ChannelThread_channelId_externalThreadId_idx" ON "ChannelThread"("channelId", "externalThreadId");

ALTER TABLE "ChannelThread" ADD CONSTRAINT "ChannelThread_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelThread" ADD CONSTRAINT "ChannelThread_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
