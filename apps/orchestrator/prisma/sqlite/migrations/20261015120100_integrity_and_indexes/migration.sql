-- Wave 1 (docs/review/00-plan.md §5 item 2): referential integrity + indexes, one migration for both databases.
--  X-DB-2  every row that points at a task goes with it (questions, message links, approval exceptions, queue jobs)
--          or lets go of it (a chat's active task, a schedule's `same` task) when the task is deleted;
--  X-DB-3  AuthSession.userId is a real foreign key (sessions go with the user);
--  X-DB-4/5, E-31  indexes for the subtask listing, the transcript / latest result, and the daily budget / stats scans;
--  C-04    ChannelMessageLink.kind / refId (nullable; the in-memory maps move onto them in a later step).
-- Existing orphans would make the new foreign keys fail — they are removed (or detached) first.
DELETE FROM "AgentQuestion" WHERE "taskId" NOT IN (SELECT "id" FROM "Task");
DELETE FROM "ChannelMessageLink" WHERE "taskId" NOT IN (SELECT "id" FROM "Task");
DELETE FROM "ApprovalException" WHERE "taskId" IS NOT NULL AND "taskId" NOT IN (SELECT "id" FROM "Task");
DELETE FROM "QueueJob" WHERE "taskId" NOT IN (SELECT "id" FROM "Task");
DELETE FROM "AuthSession" WHERE "userId" NOT IN (SELECT "id" FROM "User");
UPDATE "ChannelChatState" SET "activeTaskId" = NULL WHERE "activeTaskId" IS NOT NULL AND "activeTaskId" NOT IN (SELECT "id" FROM "Task");
UPDATE "Schedule" SET "taskId" = NULL WHERE "taskId" IS NOT NULL AND "taskId" NOT IN (SELECT "id" FROM "Task");

-- DropIndex
DROP INDEX "AgentEvent_taskId_idx";

-- DropIndex
DROP INDEX "Task_parentId_idx";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "agentSessionId" TEXT,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "allowText" BOOLEAN NOT NULL DEFAULT true,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "answer" TEXT,
    "answerIndex" INTEGER,
    "answeredBy" TEXT,
    "answeredById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" DATETIME,
    CONSTRAINT "AgentQuestion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentQuestion" ("agentSessionId", "allowText", "answer", "answerIndex", "answeredAt", "answeredBy", "answeredById", "createdAt", "id", "image", "multiple", "options", "question", "status", "taskId") SELECT "agentSessionId", "allowText", "answer", "answerIndex", "answeredAt", "answeredBy", "answeredById", "createdAt", "id", "image", "multiple", "options", "question", "status", "taskId" FROM "AgentQuestion";
DROP TABLE "AgentQuestion";
ALTER TABLE "new_AgentQuestion" RENAME TO "AgentQuestion";
CREATE INDEX "AgentQuestion_taskId_idx" ON "AgentQuestion"("taskId");
CREATE INDEX "AgentQuestion_status_idx" ON "AgentQuestion"("status");
CREATE TABLE "new_ApprovalException" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "taskId" TEXT,
    "toolName" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalException_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ApprovalException" ("createdAt", "id", "scope", "signature", "taskId", "toolName") SELECT "createdAt", "id", "scope", "signature", "taskId", "toolName" FROM "ApprovalException";
DROP TABLE "ApprovalException";
ALTER TABLE "new_ApprovalException" RENAME TO "ApprovalException";
CREATE INDEX "ApprovalException_toolName_idx" ON "ApprovalException"("toolName");
CREATE INDEX "ApprovalException_taskId_idx" ON "ApprovalException"("taskId");
CREATE TABLE "new_AuthSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "revokedAt" DATETIME,
    CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AuthSession" ("createdAt", "expiresAt", "id", "ip", "lastSeenAt", "revokedAt", "userAgent", "userId") SELECT "createdAt", "expiresAt", "id", "ip", "lastSeenAt", "revokedAt", "userAgent", "userId" FROM "AuthSession";
DROP TABLE "AuthSession";
ALTER TABLE "new_AuthSession" RENAME TO "AuthSession";
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
CREATE TABLE "new_ChannelChatState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "activeTaskId" TEXT,
    "agent" TEXT,
    "model" TEXT,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "voice" BOOLEAN NOT NULL DEFAULT false,
    "progress" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChannelChatState_activeTaskId_fkey" FOREIGN KEY ("activeTaskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ChannelChatState" ("activeTaskId", "agent", "channelId", "chatId", "createdAt", "id", "model", "muted", "progress", "updatedAt", "voice") SELECT "activeTaskId", "agent", "channelId", "chatId", "createdAt", "id", "model", "muted", "progress", "updatedAt", "voice" FROM "ChannelChatState";
DROP TABLE "ChannelChatState";
ALTER TABLE "new_ChannelChatState" RENAME TO "ChannelChatState";
CREATE INDEX "ChannelChatState_activeTaskId_idx" ON "ChannelChatState"("activeTaskId");
CREATE UNIQUE INDEX "ChannelChatState_channelId_chatId_key" ON "ChannelChatState"("channelId", "chatId");
CREATE TABLE "new_ChannelMessageLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" TEXT,
    "refId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelMessageLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ChannelMessageLink" ("channelId", "chatId", "createdAt", "id", "messageId", "taskId") SELECT "channelId", "chatId", "createdAt", "id", "messageId", "taskId" FROM "ChannelMessageLink";
DROP TABLE "ChannelMessageLink";
ALTER TABLE "new_ChannelMessageLink" RENAME TO "ChannelMessageLink";
CREATE INDEX "ChannelMessageLink_createdAt_idx" ON "ChannelMessageLink"("createdAt");
CREATE INDEX "ChannelMessageLink_taskId_idx" ON "ChannelMessageLink"("taskId");
CREATE UNIQUE INDEX "ChannelMessageLink_channelId_chatId_messageId_key" ON "ChannelMessageLink"("channelId", "chatId", "messageId");
CREATE TABLE "new_QueueJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "dedupKey" TEXT,
    "runAfter" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QueueJob_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_QueueJob" ("claimedAt", "createdAt", "dedupKey", "id", "payload", "runAfter", "taskId") SELECT "claimedAt", "createdAt", "dedupKey", "id", "payload", "runAfter", "taskId" FROM "QueueJob";
DROP TABLE "QueueJob";
ALTER TABLE "new_QueueJob" RENAME TO "QueueJob";
CREATE INDEX "QueueJob_runAfter_claimedAt_idx" ON "QueueJob"("runAfter", "claimedAt");
CREATE INDEX "QueueJob_taskId_idx" ON "QueueJob"("taskId");
CREATE TABLE "new_Schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "agentName" TEXT,
    "channelId" TEXT,
    "chatId" TEXT,
    "taskMode" TEXT NOT NULL DEFAULT 'same',
    "taskId" TEXT,
    "quietStart" TEXT,
    "quietEnd" TEXT,
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Schedule_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Schedule" ("agentName", "channelId", "chatId", "createdAt", "createdBy", "cron", "enabled", "id", "kind", "lastError", "lastRunAt", "lastStatus", "name", "nextRunAt", "quietEnd", "quietStart", "taskId", "taskMode", "text", "timezone", "updatedAt") SELECT "agentName", "channelId", "chatId", "createdAt", "createdBy", "cron", "enabled", "id", "kind", "lastError", "lastRunAt", "lastStatus", "name", "nextRunAt", "quietEnd", "quietStart", "taskId", "taskMode", "text", "timezone", "updatedAt" FROM "Schedule";
DROP TABLE "Schedule";
ALTER TABLE "new_Schedule" RENAME TO "Schedule";
CREATE UNIQUE INDEX "Schedule_name_key" ON "Schedule"("name");
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule"("enabled", "nextRunAt");
CREATE INDEX "Schedule_taskId_idx" ON "Schedule"("taskId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AgentEvent_taskId_kind_createdAt_idx" ON "AgentEvent"("taskId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSession_startedAt_idx" ON "AgentSession"("startedAt");

-- CreateIndex
CREATE INDEX "Task_parentId_createdAt_idx" ON "Task"("parentId", "createdAt");

