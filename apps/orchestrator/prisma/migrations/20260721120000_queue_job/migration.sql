-- Job table for the embedded (Redis-less) queue driver. BullMQ installs never
-- write here; additive and safe for both profiles.
CREATE TABLE "QueueJob" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "dedupKey" TEXT,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QueueJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "QueueJob_runAfter_claimedAt_idx" ON "QueueJob"("runAfter", "claimedAt");
CREATE INDEX "QueueJob_taskId_idx" ON "QueueJob"("taskId");
