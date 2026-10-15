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

-- AlterTable
ALTER TABLE "ChannelMessageLink" ADD COLUMN     "kind" TEXT,
ADD COLUMN     "refId" TEXT;

-- CreateIndex
CREATE INDEX "AgentEvent_taskId_kind_createdAt_idx" ON "AgentEvent"("taskId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSession_startedAt_idx" ON "AgentSession"("startedAt");

-- CreateIndex
CREATE INDEX "ChannelChatState_activeTaskId_idx" ON "ChannelChatState"("activeTaskId");

-- CreateIndex
CREATE INDEX "ChannelMessageLink_taskId_idx" ON "ChannelMessageLink"("taskId");

-- CreateIndex
CREATE INDEX "Schedule_taskId_idx" ON "Schedule"("taskId");

-- CreateIndex
CREATE INDEX "Task_parentId_createdAt_idx" ON "Task"("parentId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChannelChatState" ADD CONSTRAINT "ChannelChatState_activeTaskId_fkey" FOREIGN KEY ("activeTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentQuestion" ADD CONSTRAINT "AgentQuestion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessageLink" ADD CONSTRAINT "ChannelMessageLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalException" ADD CONSTRAINT "ApprovalException_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueJob" ADD CONSTRAINT "QueueJob_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

