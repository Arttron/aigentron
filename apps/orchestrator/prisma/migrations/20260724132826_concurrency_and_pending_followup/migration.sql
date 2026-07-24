-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "concurrency" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "PendingFollowUp" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" TEXT NOT NULL DEFAULT '[]',
    "references" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingFollowUp_taskId_createdAt_idx" ON "PendingFollowUp"("taskId", "createdAt");

-- AddForeignKey
ALTER TABLE "PendingFollowUp" ADD CONSTRAINT "PendingFollowUp_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
